import type { Kysely } from 'kysely';
import type { RoutinesDatabase } from './migrations.js';
type DB = Kysely<RoutinesDatabase>;

const admissionTails = new WeakMap<DB, Promise<void>>();
export async function serializeAdmission<T>(db: DB, run: () => Promise<T>): Promise<T> {
  const previous = admissionTails.get(db);
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  admissionTails.set(db, tail);
  // Payload storage may query this same pool. Wait before opening a transaction,
  // so lock contenders cannot take every connection storage needs to finish.
  // SQL locks still own cross-host deduplication and quota decisions.
  await previous;
  try { return await run(); }
  finally {
    release();
    if (admissionTails.get(db) === tail) admissionTails.delete(db);
  }
}
