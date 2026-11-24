import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, type Database } from '@tursodatabase/database';
import { defaultProfile, RecordStorage, tables, type ConfigChange, type Criteria, type Row, type Table } from './memory.js';
import type { McpEventOccurrence } from '../types/index.js';

function predicate(criteria: Criteria = {}) {
  const entries = Object.entries(criteria).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return {
    where: entries.length ? ' WHERE ' + entries.map(([key]) => `"${key}" = ?`).join(' AND ') : '',
    args: entries.map(([, value]) => value),
  };
}

export class TursoStorageAdapter extends RecordStorage {
  private constructor(private readonly database: Database) { super(); }

  static async open(homeDir: string) {
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    const database = await connect(join(homeDir, 'state.db'));
    try {
      const storage = new TursoStorageAdapter(database);
      for (const table of Object.keys(tables) as Table[]) {
        const columns = (tables[table] as string[]).map(field => `, "${field}" ${field === 'cursor' ? 'INTEGER' : 'TEXT'}`).join('');
        await database.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, payload TEXT NOT NULL${columns})`);
        for (const field of tables[table]) {
          await database.exec(`CREATE INDEX IF NOT EXISTS ${table}_${field} ON ${table}("${field}")`);
        }
      }
      await database.exec('CREATE INDEX IF NOT EXISTS event_occurrences_name_cursor ON event_occurrences(name, cursor)');
      await database.run('INSERT INTO profiles (id, payload, name) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM profiles)', 'default', JSON.stringify(defaultProfile()), 'default');
      return storage;
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  protected async scan<K extends Table>(table: K, criteria?: Criteria): Promise<Row<K>[]> {
    const { where, args } = predicate(criteria);
    const rows: { payload: string }[] = await this.database.all(`SELECT payload FROM ${table}${where} ORDER BY id`, ...args);
    return rows.map(row => JSON.parse(row.payload) as Row<K>);
  }
  protected async read<K extends Table>(table: K, id: string): Promise<Row<K> | null> {
    const row = await this.database.get(`SELECT payload FROM ${table} WHERE id = ?`, id);
    return row ? JSON.parse(row.payload) as Row<K> : null;
  }
  private upsert<K extends Table>(table: K, id: string, row: Row<K>) {
    const fields = ['id', 'payload', ...(tables[table] as string[])];
    const escaped = fields.map(field => `"${field}"`);
    return {
      sql: `INSERT INTO ${table} (${escaped.join(',')}) VALUES (${fields.map(() => '?').join(',')})
        ON CONFLICT(id) DO UPDATE SET ${escaped.slice(1).map(field => `${field} = excluded.${field}`).join(',')}`,
      args: [id, JSON.stringify(row), ...(tables[table] as string[]).map(field => field === 'cursor' ? Number(Reflect.get(row, field)) : Reflect.get(row, field) ?? null)],
    };
  }
  protected async write<K extends Table>(table: K, id: string, row: Row<K>) {
    const { sql, args } = this.upsert(table, id, row);
    await this.database.run(sql, ...args);
  }
  protected async remove(table: Table, id: string) {
    await this.database.run(`DELETE FROM ${table} WHERE id = ?`, id);
  }
  protected async take<K extends Table>(table: K, id: string, criteria: Criteria = {}): Promise<Row<K> | null> {
    const { where, args } = predicate({ id, ...criteria });
    const rows = await this.database.all(`DELETE FROM ${table}${where} RETURNING payload`, ...args);
    return rows[0] ? JSON.parse(rows[0].payload) as Row<K> : null;
  }
  protected async replace<K extends Table>(table: K, criteria: Criteria, rows: [string, Row<K>][]) {
    const { where, args } = predicate(criteria);
    await this.database.batch([
      { sql: `DELETE FROM ${table}${where}`, args },
      ...rows.map(([id, row]) => this.upsert(table, id, row)),
    ], 'write');
  }
  override async listEventOccurrences(filter: { name?: string; afterCursor?: string; limit?: number } = {}): Promise<McpEventOccurrence[]> {
    const conditions: string[] = [];
    const args: (number | string)[] = [];
    if (filter.name !== undefined) { conditions.push('name = ?'); args.push(filter.name); }
    if (filter.afterCursor !== undefined) { conditions.push('cursor > ?'); args.push(Number(filter.afterCursor)); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows: { payload: string }[] = await this.database.all(
      `SELECT payload FROM event_occurrences ${where} ORDER BY cursor LIMIT ?`, ...args, filter.limit ?? 100,
    );
    return rows.map(row => JSON.parse(row.payload) as McpEventOccurrence);
  }
  async applyConfig(changes: ConfigChange[]) {
    if (!changes.length) return;
    await this.database.batch(changes.map(({ table, key, row }) => row
      ? this.upsert(table, key, row)
      : { sql: `DELETE FROM ${table} WHERE id = ?`, args: [key] }), 'write');
  }

  close() { return this.database.close(); }
}
