import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { TelemetryEventFilter, TelemetryEventRecord, TelemetrySummary, TraceStore } from '../types/index.js';

export class DuckDbTraceStore implements TraceStore {
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;

  private constructor(private readonly instance: DuckDBInstance, private readonly db: DuckDBConnection) {}

  static async open(homeDir: string) {
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    const dbPath = join(homeDir, 'traces.duckdb');
    const instance = await DuckDBInstance.create(dbPath);
    await chmod(dbPath, 0o600).catch(() => {});
    let db: DuckDBConnection | undefined;
    try {
      db = await instance.connect();
      (await db.run(`CREATE TABLE IF NOT EXISTS traces (
        id VARCHAR PRIMARY KEY, timestamp VARCHAR NOT NULL, source_id VARCHAR, capability_id VARCHAR,
        profile_id VARCHAR NOT NULL, status VARCHAR NOT NULL, latency_ms DOUBLE NOT NULL, payload VARCHAR NOT NULL
      )`)).closeSync();
      return new DuckDbTraceStore(instance, db);
    } catch (error) {
      db?.closeSync();
      instance.closeSync();
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Trace store is closed'));
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  append(event: TelemetryEventRecord) {
    return this.enqueue(async () => {
      (await this.db.run('INSERT OR REPLACE INTO traces VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        event.id, event.timestamp, event.sourceId ?? null, event.capabilityId ?? null,
        event.profileId, event.status, event.latencyMs, JSON.stringify(event),
      ])).closeSync();
    });
  }

  private select(filter: TelemetryEventFilter, ordered = true) {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    for (const [column, value, operator] of [
      ['profile_id', filter.profileId, '='], ['source_id', filter.sourceId, '='], ['timestamp', filter.since, '>='],
    ]) {
      if (value === undefined) continue;
      conditions.push(`${column} ${operator} ?`);
      values.push(value);
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const limit = filter.limit === undefined ? '' : ' LIMIT ?';
    if (filter.limit !== undefined) values.push(filter.limit);
    const order = ordered || limit ? ' ORDER BY timestamp DESC, id' : '';
    return { sql: `SELECT * FROM traces${where}${order}${limit}`, values };
  }

  private async rows(sql: string, values: (string | number)[]) {
    const reader = await this.db.runAndReadAll(sql, values);
    try { return reader.getRowObjects(); } finally { reader.closeSync(); }
  }

  query(filter: TelemetryEventFilter = {}) {
    return this.enqueue(async () => {
      const { sql, values } = this.select(filter);
      return (await this.rows(`SELECT payload FROM (${sql})`, values))
        .map(row => JSON.parse(String(row.payload)) as TelemetryEventRecord);
    });
  }

  summarize(filter: TelemetryEventFilter = {}): Promise<TelemetrySummary> {
    return this.enqueue(async () => {
      const { sql, values } = this.select(filter, false);
      const rows = await this.rows(`SELECT source_id, capability_id, profile_id, status,
        count(*) AS calls, count(*) FILTER (WHERE status != 'ok') AS errors,
        avg(latency_ms) AS avg_latency, quantile_cont(latency_ms, 0.50) AS p50,
        quantile_cont(latency_ms, 0.95) AS p95,
        GROUPING(source_id, capability_id, profile_id, status) AS grouping_key
        FROM (${sql}) GROUP BY GROUPING SETS ((), (source_id), (capability_id), (profile_id), (status))`, values);
      const totals = rows.find(row => Number(row.grouping_key) === 15)!;
      const totalCalls = Number(totals.calls);
      const errorCount = Number(totals.errors);
      const breakdown = (group: number, field: string) => rows
        .filter(row => Number(row.grouping_key) === group && row[field] != null)
        .map(row => ({
          key: String(row[field]), calls: Number(row.calls), errors: Number(row.errors),
          errorRate: Number(row.errors) / Number(row.calls),
          avgLatencyMs: Number(row.avg_latency), p95LatencyMs: Number(row.p95),
        })).sort((a, b) => a.key.localeCompare(b.key));
      return {
        totalCalls, errorCount, errorRate: totalCalls ? errorCount / totalCalls : 0,
        p50LatencyMs: Number(totals.p50), p95LatencyMs: Number(totals.p95),
        bySource: breakdown(7, 'source_id'), byCapability: breakdown(11, 'capability_id'),
        byProfile: breakdown(13, 'profile_id'),
        byStatus: Object.fromEntries(rows.filter(row => Number(row.grouping_key) === 14)
          .map(row => [String(row.status), Number(row.calls)])),
      };
    });
  }

  close() {
    return this.closing ??= this.queue.then(() => {
      this.db.closeSync();
      this.instance.closeSync();
    });
  }
}
