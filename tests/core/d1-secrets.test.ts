import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { D1DatabaseLike } from '../../src/storage/d1.js';
import { D1SecretStore } from '../../src/storage/d1-secrets.js';

const KEY = 'test-master-key-0123456789abcdef';

function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const statement = (query: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(query, values),
    all: async <T,>() => ({ results: sqlite.prepare(query).all(...(bound as never[])) as T[] }),
    first: async <T,>() => (sqlite.prepare(query).get(...(bound as never[])) as T | undefined) ?? null,
    run: async () => sqlite.prepare(query).run(...(bound as never[])),
  });
  const db: D1DatabaseLike = {
    prepare: (query) => statement(query),
    batch: async (statements) => Promise.all(statements.map((s) => s.run())),
  };
  const ciphertext = (name: string) =>
    (sqlite.prepare('SELECT ciphertext FROM secrets_vault WHERE name = ?').get(name) as { ciphertext: string }).ciphertext;
  const setCiphertext = (name: string, value: string) =>
    sqlite.prepare('UPDATE secrets_vault SET ciphertext = ? WHERE name = ?').run(value, name);
  return { db, sqlite, ciphertext, setCiphertext };
}

const open: Array<ReturnType<typeof sqliteD1>> = [];
const vault = () => {
  const d1 = sqliteD1();
  open.push(d1);
  return d1;
};
afterEach(() => {
  for (const d1 of open.splice(0)) d1.sqlite.close();
});

const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error & { code?: string };
};

describe('D1SecretStore', () => {
  it('shares one durable vault across isolates without serving stale values', async () => {
    const { db } = vault();
    const a = await D1SecretStore.open(db, KEY);
    const b = await D1SecretStore.open(db, KEY);

    const written = await a.set('alpha', 'alpha-secret-value', 'first');
    expect(written).toMatchObject({ name: 'alpha', description: 'first' });
    expect(await b.get('alpha')).toBe('alpha-secret-value');
    expect(await b.has('alpha')).toBe(true);
    expect(await b.listMetadata()).toEqual([{ name: 'alpha', description: 'first', updatedAt: written.updatedAt }]);

    await b.set('alpha', 'alpha-rotated-value');
    await b.set('beta', 'beta-secret-value');
    expect(await a.get('alpha')).toBe('alpha-rotated-value');
    expect((await a.listMetadata()).map((m) => [m.name, m.description])).toEqual([
      ['alpha', undefined],
      ['beta', undefined],
    ]);

    await a.delete('alpha');
    expect(await b.get('alpha')).toBeNull();
    expect(await b.has('alpha')).toBe(false);
    expect((await b.listMetadata()).map((m) => m.name)).toEqual(['beta']);

    const reopened = await D1SecretStore.open(db, KEY);
    expect(await reopened.get('beta')).toBe('beta-secret-value');
    expect(await reopened.get('missing')).toBeNull();
  });

  it('stores only versioned ciphertext with a fresh nonce per write', async () => {
    const { db, sqlite, ciphertext } = vault();
    const store = await D1SecretStore.open(db, KEY);
    await store.set('alpha', 'alpha-secret-value');
    const first = ciphertext('alpha');
    await store.set('alpha', 'alpha-secret-value');
    const second = ciphertext('alpha');

    expect(first).toMatch(/^v1:[A-Za-z0-9+/]+={0,2}$/);
    expect(second).not.toBe(first);
    const dump = JSON.stringify(sqlite.prepare('SELECT * FROM secrets_vault').all());
    expect(dump).not.toContain('alpha-secret-value');
    expect(dump).not.toContain(KEY);
  });

  it('binds each ciphertext to its secret name, so swapped rows fail to decrypt', async () => {
    const { db, ciphertext, setCiphertext } = vault();
    const store = await D1SecretStore.open(db, KEY);
    await store.set('alpha', 'alpha-secret-value');
    await store.set('beta', 'beta-secret-value');
    const [alpha, beta] = [ciphertext('alpha'), ciphertext('beta')];
    setCiphertext('alpha', beta);
    setCiphertext('beta', alpha);

    for (const name of ['alpha', 'beta']) {
      const error = await rejection(store.get(name));
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.message).not.toMatch(/secret-value/);
    }
    expect((await rejection(D1SecretStore.open(db, KEY))).code).toBe('INTERNAL_ERROR');
  });

  it('fails closed on a wrong master key without leaking plaintext or key material', async () => {
    const { db } = vault();
    const store = await D1SecretStore.open(db, KEY);
    await store.set('alpha', 'alpha-secret-value');

    const error = await rejection(D1SecretStore.open(db, 'a-different-master-key'));
    expect(error.code).toBe('INTERNAL_ERROR');
    for (const leak of ['alpha-secret-value', KEY, 'a-different-master-key', 'v1:']) {
      expect(`${error.message} ${error.stack}`).not.toContain(leak);
    }

    const empty = vault();
    const reader = await D1SecretStore.open(empty.db, KEY);
    const misconfigured = await D1SecretStore.open(empty.db, 'a-different-master-key');
    await misconfigured.set('alpha', 'alpha-secret-value');
    expect((await rejection(reader.get('alpha'))).code).toBe('INTERNAL_ERROR');
  });

  it('rejects tampered, malformed, and unknown-version ciphertext', async () => {
    const { db, ciphertext, setCiphertext } = vault();
    const store = await D1SecretStore.open(db, KEY);
    await store.set('alpha', 'alpha-secret-value');
    const good = ciphertext('alpha');
    const body = good.slice(3);
    const flipped = body[20] === 'A' ? 'B' : 'A';

    for (const bad of [
      `v1:${body.slice(0, 20)}${flipped}${body.slice(21)}`,
      `v1:${body.slice(0, 24)}`,
      'v1:',
      'v1:not*base64!',
      'v1:QUJD',
      `v2:${body}`,
      body,
      'alpha-secret-value',
    ]) {
      setCiphertext('alpha', bad);
      const error = await rejection(store.get('alpha'));
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.message).not.toContain('alpha-secret-value');
    }
    setCiphertext('alpha', good);
    expect(await store.get('alpha')).toBe('alpha-secret-value');
  });

  it('rejects an empty master key, name, or value with INVALID_INPUT', async () => {
    const { db, sqlite } = vault();
    for (const key of ['', '   ', '\n\t']) {
      expect((await rejection(D1SecretStore.open(db, key))).code).toBe('INVALID_INPUT');
    }
    const store = await D1SecretStore.open(db, KEY);
    for (const [name, value] of [['', 'value'], ['   ', 'value'], ['alpha', '']]) {
      expect((await rejection(store.set(name!, value!))).code).toBe('INVALID_INPUT');
    }
    expect((await rejection(store.set('alpha', 42 as unknown as string))).code).toBe('INVALID_INPUT');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM secrets_vault').get()).toEqual({ n: 0 });
  });

  it('redacts stored values and token patterns synchronously as the vault changes', async () => {
    const { db } = vault();
    const writer = await D1SecretStore.open(db, KEY);
    await writer.set('alpha', 'alpha-secret-value');

    const reader = await D1SecretStore.open(db, KEY);
    expect(reader.redact('saw alpha-secret-value and ghp_abc123')).toBe('saw [REDACTED] and [REDACTED]');

    await writer.set('beta', 'beta-secret-value');
    expect(reader.redact('beta-secret-value')).toBe('beta-secret-value');
    await reader.get('beta');
    expect(reader.redact('beta-secret-value')).toBe('[REDACTED]');

    await reader.set('gamma', 'gamma-secret-value');
    expect(
      reader.redactValue({ list: ['gamma-secret-value'], 'alpha-secret-value': 'Bearer abcdef123456', n: 1 }),
    ).toEqual({ list: ['[REDACTED]'], '[REDACTED]': '[REDACTED]', n: 1 });

    await reader.delete('gamma');
    expect(reader.redact('gamma-secret-value')).toBe('gamma-secret-value');
    await writer.delete('alpha');
    await reader.get('alpha');
    expect(reader.redact('alpha-secret-value')).toBe('alpha-secret-value');
  });
});
