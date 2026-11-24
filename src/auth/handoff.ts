import { GatewayError, type GatewayMode, type SecretStore, type SourceRecord, type StorageAdapter } from '../types/index.js';
import { hashToken, randomToken } from './middleware.js';

export function sourceSecretNames(source: SourceRecord) {
  const auth = source.authConfig;
  return [...new Set([
    ...(auth.requiredSecrets ?? []), ...Object.values(auth.envMap ?? {}), ...(auth.secretName ? [auth.secretName] : []),
  ])];
}

export function createAuthHandoffs(storage: StorageAdapter, secrets: SecretStore, publicUrl: string, mode: GatewayMode) {
  return {
    async issue(source: SourceRecord, message: string) {
      const ticket = randomToken('af_ticket_');
      const reason = secrets.redact(message);
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      await storage.saveAuthTicket({ ticketHash: hashToken(ticket), sourceId: source.id,
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
      if (!source || !record || !(Date.parse(record.expiresAt) > Date.now())) return { valid: false };
      return { valid: true, source, reason: record.reason };
    },
    async complete(sourceId: string, ticket: string, values: Record<string, string>) {
      const source = await storage.getSource(sourceId);
      if (!source) throw new GatewayError('UNAUTHORIZED', 'Invalid auth ticket');
      const names = sourceSecretNames(source);
      const entries = Object.entries(values);
      if (entries.some(([name, value]) => !names.includes(name) || typeof value !== 'string' || !value.length)) {
        throw new GatewayError('INVALID_INPUT', 'Unexpected or empty source credential');
      }
      const record = await storage.consumeAuthTicket(sourceId, hashToken(ticket));
      if (!record || !(Date.parse(record.expiresAt) > Date.now())) throw new GatewayError('UNAUTHORIZED', 'Invalid or expired auth ticket');
      for (const [name, value] of entries) await secrets.set(name, value);
      return source;
    },
  };
}
