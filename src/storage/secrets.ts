import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretMetadata, SecretStore } from '../types/index.js';
import { GatewayError } from '../types/index.js';

interface SecretEntry extends SecretMetadata { value: string }

const secretTokenPattern = /\b(?:(?:af_tok_|af_code_|af_refresh_|af_ticket_|whsec_)[\w.+=/-]+|Bearer[ \t]+(?!(?:token|header|scheme|auth|credential)\b)[\w~+./=-]{6,}|sk-(?!learn\b)[\w-]{3,}|ghp_[\w-]+)\b/gi;

export function redactPatterns(input: string) {
  return input.replace(secretTokenPattern, '[REDACTED]');
}

function compileRedactor(secretValues: Iterable<string>): (input: string) => string {
  const values = [...new Set(secretValues)].filter(value => value.length >= 4).sort((a, b) => b.length - a.length);
  const escaped = values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const valuePattern = escaped.length ? new RegExp('(?=(' + escaped.join('|') + '))', 'g') : undefined;
  return (input: string) => {
    const ranges = [...input.matchAll(new RegExp(secretTokenPattern.source, 'gi'))]
      .map(match => [match.index, match.index + match[0].length]);
    if (valuePattern) {
      for (const match of input.matchAll(valuePattern)) ranges.push([match.index, match.index + match[1].length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let result = '';
    let end = 0;
    for (const [start, stop] of ranges) {
      if (start >= end) result += input.slice(end, start) + '[REDACTED]';
      end = Math.max(end, stop);
    }
    return result + input.slice(end);
  };
}

export function redactWithValues(input: string, secretValues: Iterable<string>): string {
  return compileRedactor(secretValues)(input);
}

export function redactValueWithValues<T>(value: T, secretValues: Iterable<string>): T {
  const redact = compileRedactor(secretValues);
  const seen = new WeakMap<object, unknown>();
  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string') return redact(entry);
    if (entry === null || typeof entry !== 'object') return entry;
    if (seen.has(entry)) return seen.get(entry);
    if (Array.isArray(entry)) {
      const result: unknown[] = [];
      seen.set(entry, result);
      for (const child of entry) result.push(visit(child));
      return result;
    }
    const result: Record<string, unknown> = {};
    seen.set(entry, result);
    for (const [key, child] of Object.entries(entry)) {
      Object.defineProperty(result, redact(key), { value: visit(child), enumerable: true, configurable: true });
    }
    return result;
  };
  return visit(value) as T;
}

export class InMemorySecretStore implements SecretStore {
  protected entries = new Map<string, SecretEntry>();
  private queue: Promise<unknown> = Promise.resolve();

  async listMetadata() { return [...this.entries.values()].map(({ value: _value, ...metadata }) => metadata); }
  async get(name: string) { return this.entries.get(name)?.value ?? null; }
  async has(name: string) { return this.entries.has(name); }
  protected async persist(_entries: Map<string, SecretEntry>) {}

  private change<T>(mutate: (entries: Map<string, SecretEntry>) => T) {
    const operation = this.queue.then(async () => {
      const entries = new Map(this.entries);
      const result = mutate(entries);
      await this.persist(entries);
      this.entries = entries;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async set(name: string, value: string, description?: string) {
    if (!name.trim() || typeof value !== 'string' || !value.length) {
      throw new GatewayError('INVALID_INPUT', 'A secret name and value are required');
    }
    const metadata = { name, description, updatedAt: new Date().toISOString() };
    return this.change(entries => {
      entries.set(name, { ...metadata, value });
      return metadata;
    });
  }
  async delete(name: string) { await this.change(entries => entries.delete(name)); }

  redact(input: string) { return redactWithValues(input, this.secretValues()); }
  redactValue<T>(value: T): T { return redactValueWithValues(value, this.secretValues()); }
  private secretValues() { return [...this.entries.values()].map(entry => entry.value); }
}

export class EncryptedSecretStore extends InMemorySecretStore {
  private constructor(private readonly path: string, private readonly key: Buffer) { super(); }

  static async open(homeDir: string) {
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    const keyPath = join(homeDir, 'master.key');
    const supplied = process.env.AGENTFABRIC_MASTER_KEY;
    let key: Buffer;
    if (supplied !== undefined) {
      if (!supplied.length) throw new Error('AGENTFABRIC_MASTER_KEY is empty');
      key = scryptSync(supplied, 'AgentFabric secret store v1', 32);
    } else {
      try { await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await chmod(keyPath, 0o600);
      key = await readFile(keyPath);
      if (key.length !== 32) throw new Error('Invalid master.key length');
    }
    const path = join(homeDir, 'secrets.enc');
    const store = new EncryptedSecretStore(path, key);
    let encrypted: Buffer;
    try { encrypted = await readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw error;
    }
    await chmod(path, 0o600);
    if (encrypted.length < 29 || encrypted[0] !== 1) throw new Error('Invalid encrypted secret store');
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(1, 13));
    decipher.setAuthTag(encrypted.subarray(13, 29));
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(29)), decipher.final()]);
    store.entries = new Map(JSON.parse(plaintext.toString('utf8')) as [string, SecretEntry][]);
    return store;
  }

  protected override async persist(entries: Map<string, SecretEntry>) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const payload = Buffer.concat([cipher.update(JSON.stringify([...entries])), cipher.final()]);
    const tmp = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), payload]), { flag: 'wx', mode: 0o600 });
      await rename(tmp, this.path);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}
