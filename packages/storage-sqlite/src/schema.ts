import { Kysely, SqliteDialect, type Generated } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';

export interface KvRow {
  key: string;
  value: Buffer;
  updated_at: Generated<string>;
}

export interface Database {
  kv: KvRow;
}

export function openDatabase(databasePath: string): Kysely<Database> {
  const driver = new BetterSqlite3(databasePath);
  driver.pragma('journal_mode = WAL');
  driver.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: driver }),
  });
}
