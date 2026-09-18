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
  migrate(db);

  return db;
}

/**
 * Columns added to `memories` after the first release, in order.
 *
 * `schema.sql` is all `CREATE TABLE IF NOT EXISTS`, so a database file created before a
 * column existed keeps its old shape forever and every query naming the new column fails at
 * runtime rather than at open. This closes that gap: additive, idempotent, and it runs on
 * every open so there is no version counter to keep honest.
 *
 * Additive only, deliberately. A rename or a drop would need a table rebuild and a real
 * migration story; nothing here has earned one, and an `ALTER ... ADD COLUMN` cannot lose a
 * row. Keep it that way.
 */
const ADDED_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "slot", ddl: "ALTER TABLE memories ADD COLUMN slot TEXT" },
  {
    // No CHECK clause here, unlike `schema.sql`. A migrated database therefore accepts any
    // string in this column where a fresh one does not — acceptable because the only writer
    // is `insertMemory`, which takes a typed `Provenance`, and worth less than the table
    // rebuild that adding the constraint retroactively would cost.
    name: "provenance",
    ddl: "ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'extracted'",
  },
  { name: "closed_by", ddl: "ALTER TABLE memories ADD COLUMN closed_by TEXT" },
];

function migrate(db: Database.Database): void {
  const present = new Set(
    (db.pragma("table_info(memories)") as Array<{ name: string }>).map((column) => column.name),
  );
  for (const column of ADDED_COLUMNS) {
    if (!present.has(column.name)) db.exec(column.ddl);
  }
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}
