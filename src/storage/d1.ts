import type { McpEventOccurrence } from '../types/index.js';
import {
  defaultProfile,
  RecordStorage,
  tables,
  type ConfigChange,
  type Criteria,
  type Row,
  type Table,
} from './memory.js';

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

function predicate(criteria: Criteria = {}) {
  const entries = Object.entries(criteria).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return {
    where: entries.length
      ? ' WHERE ' + entries.map(([key]) => `"${key}" = ?`).join(' AND ')
      : '',
    args: entries.map(([, value]) => value),
  };
}

/**
 * Durable Cloudflare D1 storage adapter extending RecordStorage.
 * Persists gateway state across Worker isolate restarts without local filesystem access.
 */
export class D1StorageAdapter extends RecordStorage {
  private initPromise?: Promise<void>;

  private constructor(private readonly db: D1DatabaseLike) {
    super();
  }

  static async open(db: D1DatabaseLike): Promise<D1StorageAdapter> {
    const storage = new D1StorageAdapter(db);
    await storage.ensureSchema();
    return storage;
  }

  private ensureSchema(): Promise<void> {
    this.initPromise ??= (async () => {
      const statements: D1PreparedStatementLike[] = [];
      for (const table of Object.keys(tables) as Table[]) {
        const columns = (tables[table] as string[])
          .map((field) => `, "${field}" ${field === 'cursor' ? 'INTEGER' : 'TEXT'}`)
          .join('');
        statements.push(
          this.db.prepare(
            `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, payload TEXT NOT NULL${columns})`,
          ),
        );
        for (const field of tables[table]) {
          statements.push(
            this.db.prepare(
              `CREATE INDEX IF NOT EXISTS ${table}_${field} ON ${table}("${field}")`,
            ),
          );
        }
      }
      statements.push(
        this.db.prepare(
          'CREATE INDEX IF NOT EXISTS event_occurrences_name_cursor ON event_occurrences(name, cursor)',
        ),
      );
      statements.push(
        this.db
          .prepare(
            'INSERT INTO profiles (id, payload, name) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM profiles)',
          )
          .bind('default', JSON.stringify(defaultProfile()), 'default'),
      );
      await this.db.batch(statements);
    })();
    return this.initPromise;
  }

  private statement<K extends Table>(table: K, id: string, row: Row<K>): D1PreparedStatementLike {
    const fields = ['id', 'payload', ...(tables[table] as string[])];
    const escaped = fields.map((field) => `"${field}"`);
    const sql = `INSERT INTO ${table} (${escaped.join(',')}) VALUES (${fields.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${escaped.slice(1).map((field) => `${field} = excluded.${field}`).join(',')}`;
    const args = [
      id,
      JSON.stringify(row),
      ...(tables[table] as string[]).map((field) =>
        field === 'cursor' ? Number(Reflect.get(row, field)) : Reflect.get(row, field) ?? null,
      ),
    ];
    return this.db.prepare(sql).bind(...args);
  }

  protected async scan<K extends Table>(table: K, criteria?: Criteria): Promise<Row<K>[]> {
    await this.ensureSchema();
    const { where, args } = predicate(criteria);
    const stmt = this.db.prepare(`SELECT payload FROM ${table}${where} ORDER BY id`);
    const bound = args.length ? stmt.bind(...args) : stmt;
    const { results = [] } = await bound.all<{ payload: string }>();
    return results.map((row) => JSON.parse(row.payload) as Row<K>);
  }

  protected async read<K extends Table>(table: K, id: string): Promise<Row<K> | null> {
    await this.ensureSchema();
    const row = await this.db
      .prepare(`SELECT payload FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<{ payload: string }>();
    return row ? (JSON.parse(row.payload) as Row<K>) : null;
  }

  protected async write<K extends Table>(table: K, id: string, row: Row<K>): Promise<void> {
    await this.ensureSchema();
    await this.statement(table, id, row).run();
  }

  protected async remove(table: Table, id: string): Promise<void> {
    await this.ensureSchema();
    await this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
  }

  protected async take<K extends Table>(
    table: K,
    id: string,
    criteria: Criteria = {},
  ): Promise<Row<K> | null> {
    await this.ensureSchema();
    const { where, args } = predicate({ id, ...criteria });
    const row = await this.db
      .prepare(`DELETE FROM ${table}${where} RETURNING payload`)
      .bind(...args)
      .first<{ payload: string }>();
    return row ? (JSON.parse(row.payload) as Row<K>) : null;
  }

  protected async replace<K extends Table>(
    table: K,
    criteria: Criteria,
    rows: [string, Row<K>][],
  ): Promise<void> {
    await this.ensureSchema();
    const { where, args } = predicate(criteria);
    const delStmt = this.db.prepare(`DELETE FROM ${table}${where}`);
    const boundDel = args.length ? delStmt.bind(...args) : delStmt;
    await this.db.batch([boundDel, ...rows.map(([id, row]) => this.statement(table, id, row))]);
  }

  override async listEventOccurrences(
    filter: { name?: string; afterCursor?: string; limit?: number } = {},
  ): Promise<McpEventOccurrence[]> {
    await this.ensureSchema();
    const conditions: string[] = [];
    const args: (number | string)[] = [];
    if (filter.name !== undefined) {
      conditions.push('name = ?');
      args.push(filter.name);
    }
    if (filter.afterCursor !== undefined) {
      conditions.push('cursor > ?');
      args.push(Number(filter.afterCursor));
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { results = [] } = await this.db
      .prepare(`SELECT payload FROM event_occurrences ${where} ORDER BY cursor LIMIT ?`)
      .bind(...args, filter.limit ?? 100)
      .all<{ payload: string }>();
    return results.map((row) => JSON.parse(row.payload) as McpEventOccurrence);
  }

  async applyConfig(changes: ConfigChange[]): Promise<void> {
    await this.ensureSchema();
    if (!changes.length) return;
    await this.db.batch(
      changes.map(({ table, key, row }) =>
        row
          ? this.statement(table, key, row)
          : this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(key),
      ),
    );
  }

  async close(): Promise<void> {}
}
