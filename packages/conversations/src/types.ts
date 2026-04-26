/**
 * @ax/conversations public types.
 *
 * Hook payload shapes land in Task 2 alongside the actual `conversations:*`
 * implementations. Task 1 (scaffold) only ships the empty plugin shell so
 * the package builds and the manifest is reachable by the canary
 * acceptance test.
 *
 * Per Invariant I1, no field name in this file should ever encode a
 * particular backend (no `pg_`, `bucket_`, `sha`, `pod_name`, etc.). The
 * canonical alternate impl we keep in mind is `@ax/conversations-sqlite`
 * for single-replica dev.
 */

export interface ConversationsConfig {
  // No config knobs in MVP — postgres + kysely come from the
  // @ax/database-postgres service via the bus. Knobs may land alongside
  // Task 2 (e.g. soft-delete retention window) but only if a second
  // backend would also want them.
}
