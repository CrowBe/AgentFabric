import type { SecretMetadata, SecretStore } from '../types/index.js';
import { GatewayError } from '../types/index.js';
import type { D1DatabaseLike } from './d1.js';
import { redactValueWithValues, redactWithValues } from './secrets.js';

const VERSION = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_SALT = 'AgentFabric D1 secret vault salt v1';
const KEY_INFO = 'AgentFabric D1 secret vault AES-256-GCM v1';
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

interface VaultRow {
  name: string;
  description: string | null;
  updated_at: string;
  ciphertext: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return undefined;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(masterKey: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', utf8.encode(masterKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(KEY_SALT), info: utf8.encode(KEY_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const undecryptable = (name: string) =>
  new GatewayError('INTERNAL_ERROR', `Secret "${name}" could not be decrypted with the configured master key`);

export class D1SecretStore implements SecretStore {
  private schema?: Promise<void>;
  private readonly known = new Map<string, string>();

  private constructor(private readonly db: D1DatabaseLike, private readonly key: CryptoKey) {}

  static async open(db: D1DatabaseLike, masterKey: string): Promise<D1SecretStore> {
    if (typeof masterKey !== 'string' || !masterKey.trim()) {
      throw new GatewayError('INVALID_INPUT', 'AGENTFABRIC_MASTER_KEY must be a non-empty string');
    }
    const store = new D1SecretStore(db, await deriveKey(masterKey));
    await store.ensureSchema();
    const { results = [] } = await db
      .prepare('SELECT name, ciphertext FROM secrets_vault ORDER BY name')
      .all<Pick<VaultRow, 'name' | 'ciphertext'>>();
    for (const row of results) store.known.set(row.name, await store.decrypt(row.name, row.ciphertext));
    return store;
  }

  private ensureSchema(): Promise<void> {
    this.schema ??= this.db
      .prepare(
        'CREATE TABLE IF NOT EXISTS secrets_vault (name TEXT PRIMARY KEY, description TEXT, updated_at TEXT NOT NULL, ciphertext TEXT NOT NULL)',
      )
      .run()
      .then(() => undefined);
    this.schema.catch(() => {
      this.schema = undefined;
    });
    return this.schema;
  }

  private aad(name: string) {
    return utf8.encode(`${VERSION}:${name}`);
  }

  private async encrypt(name: string, value: string): Promise<string> {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: this.aad(name) }, this.key, utf8.encode(value)),
    );
    const payload = new Uint8Array(NONCE_BYTES + sealed.length);
    payload.set(nonce);
    payload.set(sealed, NONCE_BYTES);
    return `${VERSION}:${toBase64(payload)}`;
  }

  private async decrypt(name: string, stored: unknown): Promise<string> {
    const prefix = `${VERSION}:`;
    if (typeof stored !== 'string' || !stored.startsWith(prefix)) throw undecryptable(name);
    const payload = fromBase64(stored.slice(prefix.length));
    if (!payload || payload.length < NONCE_BYTES + TAG_BYTES) throw undecryptable(name);
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: payload.subarray(0, NONCE_BYTES), additionalData: this.aad(name) },
        this.key,
        payload.subarray(NONCE_BYTES),
      );
      return fromUtf8.decode(plaintext);
    } catch {
      throw undecryptable(name);
    }
  }

  async listMetadata(): Promise<SecretMetadata[]> {
    await this.ensureSchema();
    const { results = [] } = await this.db
      .prepare('SELECT name, description, updated_at FROM secrets_vault ORDER BY name')
      .all<Omit<VaultRow, 'ciphertext'>>();
    return results.map((row) => ({
      name: row.name,
      ...(row.description != null ? { description: row.description } : {}),
      updatedAt: row.updated_at,
    }));
  }

  async get(name: string): Promise<string | null> {
    await this.ensureSchema();
    const row = await this.db
      .prepare('SELECT ciphertext FROM secrets_vault WHERE name = ?')
      .bind(name)
      .first<Pick<VaultRow, 'ciphertext'>>();
    if (!row) {
      this.known.delete(name);
      return null;
    }
    const value = await this.decrypt(name, row.ciphertext);
    this.known.set(name, value);
    return value;
  }

  async has(name: string): Promise<boolean> {
    await this.ensureSchema();
    const row = await this.db.prepare('SELECT 1 AS present FROM secrets_vault WHERE name = ?').bind(name).first();
    return row !== null;
  }

  async set(name: string, value: string, description?: string): Promise<SecretMetadata> {
    if (typeof name !== 'string' || !name.trim() || typeof value !== 'string' || !value.length) {
      throw new GatewayError('INVALID_INPUT', 'A secret name and value are required');
    }
    await this.ensureSchema();
    const metadata: SecretMetadata = { name, ...(description !== undefined ? { description } : {}), updatedAt: new Date().toISOString() };
    await this.db
      .prepare(
        'INSERT INTO secrets_vault (name, description, updated_at, ciphertext) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(name) DO UPDATE SET description = excluded.description, updated_at = excluded.updated_at, ciphertext = excluded.ciphertext',
      )
      .bind(name, description ?? null, metadata.updatedAt, await this.encrypt(name, value))
      .run();
    this.known.set(name, value);
    return metadata;
  }

  async delete(name: string): Promise<void> {
    await this.ensureSchema();
    await this.db.prepare('DELETE FROM secrets_vault WHERE name = ?').bind(name).run();
    this.known.delete(name);
  }

  redact(input: string): string {
    return redactWithValues(input, this.known.values());
  }

  redactValue<T>(value: T): T {
    return redactValueWithValues(value, this.known.values());
  }
}
