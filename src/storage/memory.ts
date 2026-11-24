import type * as T from '../types/index.js';
import { GatewayError } from '../types/index.js';

interface Tables {
  sources: T.SourceRecord;
  capabilities: T.CapabilityRecord;
  overlays: T.NormalizationOverlay;
  profiles: T.ProfileRecord;
  policies: T.SafetyPolicyRule;
  approvals: T.ApprovalRequestRecord;
  proposals: T.CapabilityProposalRecord;
  telemetry: T.TelemetryEventRecord;
  client_tokens: T.StoredClientToken;
  oauth_clients: T.OAuthClientRecord;
  oauth_codes: T.OAuthAuthorizationCodeRecord;
  oauth_refresh_tokens: T.OAuthRefreshTokenRecord;
  auth_tickets: T.AuthTicketRecord;
  event_types: T.McpEventTypeRecord;
  event_occurrences: T.McpEventOccurrence;
  event_subscriptions: T.McpEventSubscriptionRecord;
}

export const tables = {
  sources: ['name'], capabilities: ['sourceId'], overlays: [], profiles: ['name'],
  policies: [], approvals: ['status'], proposals: ['status'],
  telemetry: ['profileId', 'sourceId', 'timestamp'], client_tokens: ['tokenHash'],
  oauth_clients: [], oauth_codes: [], oauth_refresh_tokens: [], auth_tickets: ['sourceId'],
  event_types: ['sourceId'], event_occurrences: ['name', 'cursor'], event_subscriptions: ['profileId'],
} satisfies Record<keyof Tables, string[]>;

export type Table = keyof Tables;
export type Row<K extends Table> = Tables[K];
export type Criteria = Record<string, string | undefined>;
export type ConfigChange = { table: Table; key: string; row?: Row<Table> };

export function defaultProfile(): T.ProfileRecord {
  const timestamp = new Date().toISOString();
  return {
    id: 'default', name: 'default', description: '', defaultExposure: 'direct',
    directToolBudget: 24, rules: [], createdAt: timestamp, updatedAt: timestamp,
  };
}

function assertHash(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new GatewayError('INVALID_INPUT', 'Expected a SHA-256 hash');
}

export abstract class RecordStorage implements T.StorageAdapter {
  protected abstract scan<K extends Table>(table: K, criteria?: Criteria): Promise<Row<K>[]>;
  protected abstract read<K extends Table>(table: K, key: string): Promise<Row<K> | null>;
  protected abstract write<K extends Table>(table: K, key: string, row: Row<K>): Promise<void>;
  protected abstract remove(table: Table, key: string): Promise<void>;
  protected abstract take<K extends Table>(table: K, key: string, criteria?: Criteria): Promise<Row<K> | null>;
  protected abstract replace<K extends Table>(table: K, criteria: Criteria, rows: [string, Row<K>][]): Promise<void>;
  abstract applyConfig(changes: ConfigChange[]): Promise<void>;
  abstract close(): Promise<void>;

  listSources() { return this.scan('sources'); }
  getSource(id: string) { return this.read('sources', id); }
  async getSourceByName(name: string) { return (await this.scan('sources', { name }))[0] ?? null; }
  upsertSource(row: T.SourceRecord) { return this.write('sources', row.id, row); }
  async deleteSource(id: string) {
    await this.remove('sources', id);
    const caps = await this.listCapabilities(id);
    await this.replaceSourceCapabilities(id, []);
    await Promise.all(caps.map(cap => this.deleteOverlay(cap.id)));
    await this.deleteEventTypesBySource(id);
  }
  listCapabilities(sourceId?: string) { return this.scan('capabilities', { sourceId }); }
  getCapability(id: string) { return this.read('capabilities', id); }
  replaceSourceCapabilities(sourceId: string, rows: T.CapabilityRecord[]) {
    if (rows.some(row => row.sourceId !== sourceId)) throw new GatewayError('INVALID_INPUT', 'Capability source mismatch');
    return this.replace('capabilities', { sourceId }, rows.map(row => [row.id, row]));
  }
  listOverlays() { return this.scan('overlays'); }
  getOverlay(id: string) { return this.read('overlays', id); }
  upsertOverlay(row: T.NormalizationOverlay) { return this.write('overlays', row.capabilityId, row); }
  deleteOverlay(id: string) { return this.remove('overlays', id); }
  listProfiles() { return this.scan('profiles'); }
  async getProfile(idOrName: string) {
    return (await this.read('profiles', idOrName)) ?? (await this.scan('profiles', { name: idOrName }))[0] ?? null;
  }
  upsertProfile(row: T.ProfileRecord) { return this.write('profiles', row.id, row); }
  deleteProfile(id: string) { return this.remove('profiles', id); }
  listPolicies() { return this.scan('policies'); }
  getPolicy(id: string) { return this.read('policies', id); }
  upsertPolicy(row: T.SafetyPolicyRule) { return this.write('policies', row.id, row); }
  deletePolicy(id: string) { return this.remove('policies', id); }
  listApprovals(status?: T.ApprovalStatus) { return this.scan('approvals', { status }); }
  getApproval(id: string) { return this.read('approvals', id); }
  upsertApproval(row: T.ApprovalRequestRecord) { return this.write('approvals', row.id, row); }
  listProposals(status?: T.ProposalStatus) { return this.scan('proposals', { status }); }
  getProposal(id: string) { return this.read('proposals', id); }
  upsertProposal(row: T.CapabilityProposalRecord) { return this.write('proposals', row.id, row); }
  appendTelemetryEvent(row: T.TelemetryEventRecord) { return this.write('telemetry', row.id, row); }
  async listTelemetryEvents(filter: T.TelemetryEventFilter = {}) {
    return filterTraces(await this.scan('telemetry', { profileId: filter.profileId, sourceId: filter.sourceId }), filter);
  }
  async listClientTokens() {
    return (await this.scan('client_tokens')).map(({ tokenHash: _hash, ...record }) => record);
  }
  async getClientTokenByHash(tokenHash: string) { return (await this.scan('client_tokens', { tokenHash }))[0] ?? null; }
  upsertClientToken(row: T.StoredClientToken) {
    const { id, label, profileId, tokenPrefix, scopes, createdAt, lastUsedAt, revokedAt, tokenHash } = row;
    assertHash(tokenHash);
    return this.write('client_tokens', id, { id, label, profileId, tokenPrefix, scopes, createdAt, lastUsedAt, revokedAt, tokenHash });
  }
  private tokenUpdates = new Map<string, Promise<void>>();
  private updateToken(id: string, patch: Partial<T.StoredClientToken>) {
    const previous = this.tokenUpdates.get(id);
    const update = (previous ?? Promise.resolve()).catch(() => {}).then(async () => {
      const record = await this.read('client_tokens', id);
      if (record) await this.upsertClientToken({ ...record, ...patch });
    });
    this.tokenUpdates.set(id, update);
    return update.finally(() => {
      if (this.tokenUpdates.get(id) === update) this.tokenUpdates.delete(id);
    });
  }
  markClientTokenUsed(id: string, lastUsedAt: string) { return this.updateToken(id, { lastUsedAt }); }
  revokeClientToken(id: string, revokedAt: string) { return this.updateToken(id, { revokedAt }); }
  listOAuthClients() { return this.scan('oauth_clients'); }
  getOAuthClient(id: string) { return this.read('oauth_clients', id); }
  upsertOAuthClient(row: T.OAuthClientRecord) { return this.write('oauth_clients', row.clientId, row); }
  saveOAuthCode(row: T.OAuthAuthorizationCodeRecord) {
    assertHash(row.codeHash);
    return this.write('oauth_codes', row.codeHash, row);
  }
  consumeOAuthCode(hash: string) { return this.take('oauth_codes', hash); }
  saveOAuthRefreshToken(row: T.OAuthRefreshTokenRecord) {
    assertHash(row.tokenHash);
    return this.write('oauth_refresh_tokens', row.tokenHash, row);
  }
  getOAuthRefreshTokenByHash(hash: string) { return this.read('oauth_refresh_tokens', hash); }
  async revokeOAuthRefreshToken(hash: string, revokedAt: string) {
    const row = await this.read('oauth_refresh_tokens', hash);
    if (row) await this.saveOAuthRefreshToken({ ...row, revokedAt });
  }
  saveAuthTicket(row: T.AuthTicketRecord) {
    assertHash(row.ticketHash);
    return this.write('auth_tickets', row.ticketHash, row);
  }
  async getAuthTicket(sourceId: string, hash: string) {
    const row = await this.read('auth_tickets', hash);
    return row?.sourceId === sourceId ? row : null;
  }
  consumeAuthTicket(sourceId: string, hash: string) { return this.take('auth_tickets', hash, { sourceId }); }
  listEventTypes() { return this.scan('event_types'); }
  upsertEventType(row: T.McpEventTypeRecord) { return this.write('event_types', JSON.stringify([row.sourceId, row.name]), row); }
  deleteEventTypesBySource(sourceId: string) { return this.replace('event_types', { sourceId }, []); }
  appendEventOccurrence(row: T.McpEventOccurrence) { return this.write('event_occurrences', row.eventId, row); }
  async listEventOccurrences(filter: { name?: string; afterCursor?: string; limit?: number } = {}) {
    return (await this.scan('event_occurrences', { name: filter.name }))
      .filter(row => filter.afterCursor === undefined || Number(row.cursor) > Number(filter.afterCursor))
      .sort((a, b) => Number(a.cursor) - Number(b.cursor))
      .slice(0, filter.limit ?? 100);
  }
  listEventSubscriptions(profileId?: string) { return this.scan('event_subscriptions', { profileId }); }
  getEventSubscription(id: string) { return this.read('event_subscriptions', id); }
  upsertEventSubscription(row: T.McpEventSubscriptionRecord) { return this.write('event_subscriptions', row.id, row); }
  deleteEventSubscription(id: string) { return this.remove('event_subscriptions', id); }
}

function matches(row: object, criteria: Criteria) {
  return Object.entries(criteria).every(([field, value]) => value === undefined || Reflect.get(row, field) === value);
}

export class MemoryStorageAdapter extends RecordStorage {
  private readonly data = new Map<Table, Map<string, object>>();

  constructor() {
    super();
    const profile = defaultProfile();
    this.bucket('profiles').set(profile.id, profile);
  }

  private bucket(table: Table) {
    let bucket = this.data.get(table);
    if (!bucket) this.data.set(table, bucket = new Map());
    return bucket;
  }
  protected async scan<K extends Table>(table: K, criteria: Criteria = {}): Promise<Row<K>[]> {
    return structuredClone([...this.bucket(table).values()].filter(row => matches(row, criteria))) as Row<K>[];
  }
  protected async read<K extends Table>(table: K, key: string): Promise<Row<K> | null> {
    return structuredClone(this.bucket(table).get(key) ?? null) as Row<K> | null;
  }
  protected async write<K extends Table>(table: K, key: string, row: Row<K>) { this.bucket(table).set(key, structuredClone(row)); }
  protected async remove(table: Table, key: string) { this.bucket(table).delete(key); }
  protected async take<K extends Table>(table: K, key: string, criteria: Criteria = {}): Promise<Row<K> | null> {
    const bucket = this.bucket(table);
    const row = bucket.get(key);
    if (!row || !matches(row, criteria)) return null;
    bucket.delete(key);
    return row as Row<K>;
  }
  protected async replace<K extends Table>(table: K, criteria: Criteria, rows: [string, Row<K>][]) {
    const copies = structuredClone(rows);
    const bucket = this.bucket(table);
    for (const [key, row] of bucket) if (matches(row, criteria)) bucket.delete(key);
    for (const [key, row] of copies) bucket.set(key, row);
  }
  async applyConfig(changes: ConfigChange[]) {
    for (const { table, key, row } of structuredClone(changes)) {
      const bucket = this.bucket(table);
      if (row) bucket.set(key, row);
      else bucket.delete(key);
    }
  }
  async close() {}
}

export function filterTraces(rows: T.TelemetryEventRecord[], filter: T.TelemetryEventFilter) {
  return rows.filter(row => (filter.profileId === undefined || row.profileId === filter.profileId)
    && (filter.sourceId === undefined || row.sourceId === filter.sourceId)
    && (filter.since === undefined || row.timestamp >= filter.since))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id))
    .slice(0, filter.limit ?? Infinity);
}

export function summarizeTraces(rows: T.TelemetryEventRecord[]): T.TelemetrySummary {
  function percentile(events: T.TelemetryEventRecord[], p: number) {
    if (!events.length) return 0;
    const values = events.map(row => row.latencyMs).sort((a, b) => a - b);
    const offset = (values.length - 1) * p;
    const low = Math.floor(offset);
    return values[low] + (values[Math.ceil(offset)] - values[low]) * (offset - low);
  }
  function breakdown(field: 'sourceId' | 'capabilityId' | 'profileId') {
    const groups = new Map<string, T.TelemetryEventRecord[]>();
    for (const row of rows) {
      const key = row[field];
      if (key === undefined) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, events]) => {
      const calls = events.length;
      const errors = events.filter(row => row.status !== 'ok').length;
      return { key, calls, errors, errorRate: errors / calls,
        avgLatencyMs: events.reduce((sum, row) => sum + row.latencyMs, 0) / calls,
        p95LatencyMs: percentile(events, 0.95) };
    });
  }
  const totalCalls = rows.length;
  const errorCount = rows.filter(row => row.status !== 'ok').length;
  const byStatus: Record<string, number> = {};
  for (const { status } of rows) byStatus[status] = (byStatus[status] ?? 0) + 1;
  return {
    totalCalls, errorCount, errorRate: totalCalls ? errorCount / totalCalls : 0,
    p50LatencyMs: percentile(rows, 0.5), p95LatencyMs: percentile(rows, 0.95),
    bySource: breakdown('sourceId'), byCapability: breakdown('capabilityId'), byProfile: breakdown('profileId'), byStatus,
  };
}

export class MemoryTraceStore implements T.TraceStore {
  private readonly rows = new Map<string, T.TelemetryEventRecord>();
  async append(row: T.TelemetryEventRecord) { this.rows.set(row.id, structuredClone(row)); }
  async query(filter: T.TelemetryEventFilter = {}) {
    return structuredClone(filterTraces([...this.rows.values()], filter));
  }
  async summarize(filter?: T.TelemetryEventFilter) { return summarizeTraces(await this.query(filter)); }
  async close() {}
}
