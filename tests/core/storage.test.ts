import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DuckDbTraceStore } from '../../src/storage/trace-db.js';
import { EncryptedSecretStore, InMemorySecretStore } from '../../src/storage/secrets.js';
import { MemoryStorageAdapter, MemoryTraceStore } from '../../src/storage/memory.js';
import { TursoStorageAdapter } from '../../src/storage/turso.js';
import { exportConfig, importConfig } from '../../src/storage/portability.js';
import { hashToken } from '../../src/auth/middleware.js';
import { validateArguments, strictSchema } from '../../src/validation/schema.js';
import type { StorageAdapter, TelemetryEventRecord } from '../../src/types/index.js';

const paths: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'agentfabric-storage-'));
  paths.push(path);
  return path;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(paths.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

describe.each(['memory', 'turso'])('%s storage', kind => {
  async function open(): Promise<StorageAdapter> {
    return kind === 'memory' ? new MemoryStorageAdapter() : TursoStorageAdapter.open(join(await directory(), 'state'));
  }

  it('bootstraps the default profile and replaces one source catalog at a time', async () => {
    const storage = await open();
    try {
      expect(await storage.getProfile('default')).toMatchObject({ id: 'default' });
      const capability = { sourceId: 'source', kind: 'tool' as const, id: 'tool', originalName: 'tool',
        description: '', available: true, lastSeenAt: new Date().toISOString() };
      await storage.replaceSourceCapabilities('source', [capability]);
      await storage.replaceSourceCapabilities('other', [{ ...capability, id: 'other', sourceId: 'other' }]);
      await expect(Promise.resolve().then(() => storage.replaceSourceCapabilities('other', [capability]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await storage.listCapabilities('source')).toEqual([capability]);
      await storage.replaceSourceCapabilities('source', []);
      expect(await storage.listCapabilities()).toHaveLength(1);
    } finally { await storage.close(); }
  });

  it('keeps issued tokens hashed and consumes tickets exactly once', async () => {
    const storage = await open();
    try {
      const token = { id: 'client', label: 'client', profileId: 'default', scopes: ['mcp'],
        tokenPrefix: 'af_tok_hint', createdAt: new Date().toISOString(), tokenHash: hashToken('only-return-once') };
      await storage.upsertClientToken({ ...token, rawToken: 'only-return-once' } as typeof token);
      await Promise.all([storage.markClientTokenUsed(token.id, 'used'), storage.revokeClientToken(token.id, 'revoked')]);
      expect(await storage.getClientTokenByHash(token.tokenHash)).toMatchObject({ revokedAt: 'revoked', lastUsedAt: 'used' });
      expect(await storage.listClientTokens()).toEqual([expect.not.objectContaining({ tokenHash: expect.anything(), rawToken: expect.anything() })]);
      const ticket = { sourceId: 'source', ticketHash: hashToken('ticket'), reason: '',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
      await storage.saveAuthTicket(ticket);
      expect(await storage.consumeAuthTicket('foreign', ticket.ticketHash)).toBeNull();
      const tickets = await Promise.all(Array.from({ length: 5 }, () => storage.consumeAuthTicket('source', ticket.ticketHash)));
      expect(tickets.filter(Boolean)).toEqual([ticket]);
    } finally { await storage.close(); }
  });

  it('reads authorization codes without consuming them and revokes refresh tokens per profile only', async () => {
    const storage = await open();
    try {
      const timestamp = new Date().toISOString();
      const code = { codeHash: hashToken('code'), clientId: 'client', redirectUri: 'https://client.example/cb', codeChallenge: 'c',
        codeChallengeMethod: 'S256' as const, scope: 'mcp', profileId: 'default', createdAt: timestamp,
        expiresAt: new Date(Date.now() + 60_000).toISOString() };
      await storage.saveOAuthCode(code);
      expect(await storage.getOAuthCode(code.codeHash)).toEqual(code);
      expect(await storage.getOAuthCode(code.codeHash)).toEqual(code);
      expect(await storage.consumeOAuthCode(code.codeHash)).toEqual(code);
      expect(await storage.getOAuthCode(code.codeHash)).toBeNull();

      const refresh = (name: string, profileId: string) => ({ tokenHash: hashToken(name), clientId: 'client', profileId, scope: 'mcp',
        createdAt: timestamp, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const doomed = refresh('doomed', 'gone');
      const alreadyRevoked = { ...refresh('earlier', 'gone'), revokedAt: 'earlier' };
      const survivor = refresh('survivor', 'default');
      for (const row of [doomed, alreadyRevoked, survivor]) await storage.saveOAuthRefreshToken(row);
      await storage.revokeOAuthRefreshTokensByProfile('gone', 'now');
      expect(await storage.getOAuthRefreshTokenByHash(doomed.tokenHash)).toMatchObject({ revokedAt: 'now' });
      expect(await storage.getOAuthRefreshTokenByHash(alreadyRevoked.tokenHash)).toMatchObject({ revokedAt: 'earlier' });
      expect(await storage.getOAuthRefreshTokenByHash(survivor.tokenHash)).not.toHaveProperty('revokedAt');
    } finally { await storage.close(); }
  });

  it('lists event occurrences oldest-first by default and newest-first with a bounded desc order', async () => {
    const storage = await open();
    try {
      for (const cursor of [1, 2, 3, 10, 11]) {
        await storage.appendEventOccurrence({ eventId: `event-${cursor}`, name: cursor % 2 ? 'odd' : 'even', sourceId: 'gateway',
          timestamp: new Date(cursor * 1000).toISOString(), data: {}, cursor: String(cursor) });
      }
      const cursors = async (filter: Parameters<StorageAdapter['listEventOccurrences']>[0]) =>
        (await storage.listEventOccurrences(filter)).map(event => event.cursor);
      expect(await cursors({ limit: 2 })).toEqual(['1', '2']);
      expect(await cursors({ limit: 2, order: 'asc' })).toEqual(['1', '2']);
      expect(await cursors({ limit: 2, order: 'desc' })).toEqual(['11', '10']);
      expect(await cursors({ name: 'odd', order: 'desc' })).toEqual(['11', '3', '1']);
      expect(await cursors({ afterCursor: '2', order: 'desc', limit: 2 })).toEqual(['11', '10']);
    } finally { await storage.close(); }
  });
});

it('persists encrypted values with restrictive modes and rejects tampering', async () => {
  vi.stubEnv('AGENTFABRIC_MASTER_KEY', undefined);
  const home = join(await directory(), 'state');
  const store = await EncryptedSecretStore.open(home);
  await Promise.all([store.set('one', 'shared-secret'), store.set('two', 'shared-secret-with-suffix'), store.set('three', 'xyz')]);
  expect(await stat(home).then(info => info.mode & 0o777)).toBe(0o700);
  expect(await stat(join(home, 'master.key')).then(info => info.mode & 0o777)).toBe(0o600);
  expect(await stat(join(home, 'secrets.enc')).then(info => info.mode & 0o777)).toBe(0o600);
  const ciphertext = await readFile(join(home, 'secrets.enc'));
  expect(ciphertext.includes(Buffer.from('shared-secret'))).toBe(false);
  const reopened = await EncryptedSecretStore.open(home);
  expect(await reopened.get('two')).toBe('shared-secret-with-suffix');
  expect(reopened.redactValue({ 'shared-secret': ['shared-secret-with-suffix', 'Bearer abcdef', 'sk-key', 'ghp_foo', 'af_tok_xyz', 'xyz', 'Bearer token and sk-learn'] }))
    .toEqual({ '[REDACTED]': ['[REDACTED]', '[REDACTED]', '[REDACTED]', '[REDACTED]', '[REDACTED]', 'xyz', 'Bearer token and sk-learn'] });
  ciphertext[ciphertext.length - 1] ^= 1;
  await writeFile(join(home, 'secrets.enc'), ciphertext);
  await expect(EncryptedSecretStore.open(home)).rejects.toThrow();
});

it('writes concurrent DuckDB traces and matches in-memory vectorized summaries after reopen', async () => {
  const home = await directory();
  const traces = await DuckDbTraceStore.open(home);
  const memory = new MemoryTraceStore();
  const events: TelemetryEventRecord[] = [5, 15, 25, 35, 45].map((latencyMs, i) => ({
    id: String(i), timestamp: new Date(10_000 + i * 1000).toISOString(), profileId: i > 2 ? 'other' : 'default',
    sourceId: i > 2 ? undefined : 'source', capabilityId: 'cap', toolName: 'tool', latencyMs,
    status: i % 2 === 0 ? 'ok' : 'upstream_error', inputBytes: i, outputBytes: i * 2,
  }));
  await Promise.all(events.flatMap(event => [traces.append(event), memory.append(event)]));
  for (const filter of [{}, { profileId: 'default' }, { limit: 2 }, { profileId: 'missing' }]) {
    expect(await traces.query(filter)).toEqual(await memory.query(filter));
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, value) =>
      typeof value === 'number' ? Number(value.toPrecision(12)) : value));
    expect(normalize(await traces.summarize(filter))).toEqual(normalize(await memory.summarize(filter)));
  }
  await traces.close();
  const reopened = await DuckDbTraceStore.open(home);
  try {
    expect(await reopened.summarize()).toMatchObject({ totalCalls: 5, errorCount: 2, p50LatencyMs: 25, p95LatencyMs: 43 });
  } finally { await reopened.close(); }
});

it('rejects malformed bundles and plaintext before replacing config', async () => {
  const storage = new MemoryStorageAdapter();
  const secrets = new InMemorySecretStore();
  await secrets.set('http', 'actual-credential');
  const bundle = await exportConfig(storage, secrets);
  const source = { id: 'h', name: 'HTTP', kind: 'mcp_http', enabled: true, config: { kind: 'mcp_http', url: 'https://example.invalid/mcp' },
    authConfig: { kind: 'bearer_secret', secretName: 'http' }, refreshPolicy: { mode: 'manual' } };
  await importConfig(storage, secrets, { ...bundle, sources: [source] });
  await expect(importConfig(storage, secrets, { ...bundle, sources: [{ ...source, config: { ...source.config, headers: { Authorization: 'plaintext' } } }] }))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(importConfig(storage, secrets, { ...bundle, sources: [{ ...source, extra: 'actual-credential' }] }))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect((await exportConfig(storage, secrets)).sources).toEqual([source]);
});

it('enforces strict nested arguments, formats and typed dictionaries', () => {
  const schema = { type: 'object', properties: { data: { type: 'array', items: {
    type: 'object', properties: { date: { type: 'string', format: 'date-time' } }, required: ['date'], additionalProperties: true,
  } }, counts: { type: 'object', properties: { all: { type: 'integer' } }, additionalProperties: { type: 'integer' } } }, required: ['data'] };
  expect(() => validateArguments(schema, { data: [{ date: '2026-11-24T00:00:00Z' }], counts: { extra: 4 } })).not.toThrow();
  expect(() => validateArguments(schema, { data: [{ date: 'invalid', extra: 4 }] })).toThrow(/format/);
  expect(() => validateArguments(schema, { invalid: true })).toThrow(/required|additional/);
  expect(() => validateArguments(schema, { data: [{}] })).toThrow(/required/);
  expect(() => validateArguments({ type: 'bad' }, {})).toThrow(/schema/);
  expect((strictSchema(schema).properties as typeof schema.properties).data.items.additionalProperties).toBe(false);
  expect(schema.properties.data.items.additionalProperties).toBe(true);

  const composed = {
    type: 'object',
    allOf: [
      { properties: { a: { type: 'string' } }, required: ['a'] },
      { properties: { b: { type: 'integer' } }, required: ['b'] },
    ],
  };
  expect(() => validateArguments(composed, { a: 'ok', b: 2 })).not.toThrow();
  expect(() => validateArguments(composed, { a: 'ok' })).toThrow(/required/);
});

it('applies a validated portable bundle to Turso and invalidates the replaced catalog', async () => {
  const dir = await directory();
  const storage = await TursoStorageAdapter.open(dir);
  const secrets = new InMemorySecretStore();
  try {
    const current = await exportConfig(storage, secrets);
    const source = { id: 'skill', name: 'Skill', kind: 'skill', enabled: true,
      config: { kind: 'skill', slug: 'one', title: 'One', description: '', content: '# One' },
      authConfig: { kind: 'none' }, refreshPolicy: { mode: 'manual' } };
    await importConfig(storage, secrets, { ...current, sources: [source] });
    await storage.replaceSourceCapabilities('skill', [{ id: 'one', sourceId: 'skill', kind: 'skill', originalName: 'one',
      description: '', available: true, lastSeenAt: new Date().toISOString() }]);
    await importConfig(storage, secrets, { ...current, sources: [{ ...source, config: { ...source.config, title: 'Updated' } }] }, true);
    expect(await storage.listCapabilities()).toEqual([]);
    expect(await storage.getSource('skill')).toMatchObject({ config: { title: 'Updated' } });
  } finally { await storage.close(); }
});
