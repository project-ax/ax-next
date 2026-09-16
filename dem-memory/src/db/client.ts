import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export const SCHEMA_SQL: string = readFileSync(
  new URL("./schema.sql", import.meta.url),
  "utf8",
);

export interface OpenDatabaseOptions {
  path?: string;
  wal?: boolean;
}

export function openDatabase(options: OpenDatabaseOptions = {}): Database.Database {
  const path = options.path ?? ":memory:";
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, {
    allowExtension: true,
  } as Database.Options & { allowExtension?: boolean });

  if (options.wal !== false && path !== ":memory:") {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }

  sqliteVec.load(db);
  db.exec(SCHEMA_SQL);

  return db;
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}
