/**
 * @ax/skills user-scoped store.
 *
 * Mirrors store.ts but operates on `skills_v1_user_skills` and scopes
 * every query to `owner_user_id = ownerUserId`. This is the scope-isolation
 * boundary: user A's queries MUST NEVER touch user B's rows.
 *
 * Row mapping delegates to _row-mappers.ts (shared with store.ts) so the
 * two stores stay in sync without duplicating parsing logic.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';
import { createBundleStore, type BundleStore } from './bundle-store.js';
import {
  rowToUserDetail,
  rowToUserResolved,
  rowToUserSummary,
} from './_row-mappers.js';
import type { BundleFile, ResolvedSkill, SkillDetail, SkillSummary } from './types.js';

export interface UpsertUserSkillInput {
  ownerUserId: string;
  id: string;
  description: string;
  manifestYaml: string;
  bodyMd: string;
  version: number;
  defaultAttached?: boolean;
  sourceUrl?: string | null;
  /** Extra (non-SKILL.md) bundle files. Absent/empty = single-file skill. */
  files?: BundleFile[];
}

export interface UserSkillsStore {
  /** List all skills for the given user. Each summary has scope:'user', ownerUserId set. */
  list(ownerUserId: string): Promise<SkillSummary[]>;
  /** Get a single skill for the given user, or null if not found. */
  get(ownerUserId: string, skillId: string): Promise<SkillDetail | null>;
  /** Upsert a user-scoped skill. Returns { created: true } on insert, false on update. */
  upsert(input: UpsertUserSkillInput): Promise<{ created: boolean }>;
  /** Delete a user-scoped skill. Silent if the row doesn't exist. */
  delete(ownerUserId: string, skillId: string): Promise<void>;
  /** Resolve a list of skill IDs for the given user (preserves input order, drops unknowns). */
  resolve(ownerUserId: string, skillIds: string[]): Promise<ResolvedSkill[]>;
  /** Return all skills for the given user that have default_attached === true. */
  getDefaults(ownerUserId: string): Promise<ResolvedSkill[]>;
}

export function createUserSkillsStore(
  db: Kysely<SkillsDatabase>,
  // Shared content-addressed bundle byte-store (see store.ts). Optional so the
  // existing `createUserSkillsStore(db)` test call sites keep working; in
  // production the plugin injects the SAME instance as the global store so
  // identical bytes dedup across scopes.
  bundleStore: BundleStore = createBundleStore(mkdtempSync(join(tmpdir(), 'ax-skills-bundles-'))),
): UserSkillsStore {
  // ---- bundle extra-file helpers (content-addressed git tree byte-store) ----

  async function loadFiles(treeSha: string | null): Promise<BundleFile[]> {
    return treeSha === null ? [] : bundleStore.readTree(treeSha);
  }

  return {
    async list(ownerUserId) {
      const rows = await db
        .selectFrom('skills_v1_user_skills')
        .selectAll()
        .where('owner_user_id', '=', ownerUserId)
        .orderBy('skill_id', 'asc')
        .execute();

      return rows.map((row) => rowToUserSummary(row, ownerUserId));
    },

    async get(ownerUserId, skillId) {
      const row = await db
        .selectFrom('skills_v1_user_skills')
        .selectAll()
        .where('owner_user_id', '=', ownerUserId)
        .where('skill_id', '=', skillId)
        .executeTakeFirst();

      if (row === undefined) return null;
      return rowToUserDetail(row, ownerUserId, await loadFiles(row.bundle_tree_sha));
    },

    async upsert(input) {
      // Write the extra-file tree FIRST (only when `files` is explicitly
      // provided) — see store.ts for the §6D metadata-only-edit rationale.
      const filesProvided = input.files !== undefined;
      const treeSha = filesProvided ? await bundleStore.writeTree(input.files!) : null;

      // SELECT → INSERT or UPDATE so `created` is accurate.
      // Accepted SELECT→INSERT race: this mirrors the global store (store.ts)
      // and the rationale documented in plugin.ts applies equally here —
      // a concurrent insert of the same (owner_user_id, skill_id) pair would
      // surface as a PRIMARY KEY unique-violation, which is acceptable at the
      // admin/user (~10 skills) scale where races are astronomically rare.
      // The compound PRIMARY KEY (owner_user_id, skill_id) guards against
      // concurrent inserts for the same user+skill pair.
      const existing = await db
        .selectFrom('skills_v1_user_skills')
        .select('skill_id')
        .where('owner_user_id', '=', input.ownerUserId)
        .where('skill_id', '=', input.id)
        .executeTakeFirst();

      const created = existing === undefined;
      if (created) {
        const now = new Date();
        await db
          .insertInto('skills_v1_user_skills')
          .values({
            owner_user_id: input.ownerUserId,
            skill_id: input.id,
            description: input.description,
            manifest_yaml: input.manifestYaml,
            body_md: input.bodyMd,
            version: input.version,
            default_attached: input.defaultAttached ?? false,
            source_url: input.sourceUrl ?? null,
            bundle_tree_sha: treeSha,
            created_at: now,
            updated_at: now,
          })
          .execute();
      } else {
        await db
          .updateTable('skills_v1_user_skills')
          .set({
            description: input.description,
            manifest_yaml: input.manifestYaml,
            body_md: input.bodyMd,
            version: input.version,
            default_attached: input.defaultAttached ?? false,
            source_url: input.sourceUrl ?? null,
            // Only touch bundle_tree_sha when `files` was explicitly provided (§6D).
            ...(filesProvided ? { bundle_tree_sha: treeSha } : {}),
            updated_at: new Date(),
          })
          .where('owner_user_id', '=', input.ownerUserId)
          .where('skill_id', '=', input.id)
          .execute();
      }
      return { created };
    },

    async delete(ownerUserId, skillId) {
      // Silent if the row doesn't exist — the plugin layer adds the not-found
      // error when needed. The store is the dumb persistence layer. Just delete
      // the row: orphaned bundle objects are content-addressed and harmless.
      await db
        .deleteFrom('skills_v1_user_skills')
        .where('owner_user_id', '=', ownerUserId)
        .where('skill_id', '=', skillId)
        .execute();
    },

    async getDefaults(ownerUserId) {
      const rows = await db
        .selectFrom('skills_v1_user_skills')
        .selectAll()
        .where('owner_user_id', '=', ownerUserId)
        .where('default_attached', '=', true)
        .orderBy('skill_id', 'asc')
        .execute();

      const out: ResolvedSkill[] = [];
      for (const r of rows) out.push(rowToUserResolved(r, await loadFiles(r.bundle_tree_sha)));
      return out;
    },

    async resolve(ownerUserId, skillIds) {
      if (skillIds.length === 0) return [];

      const rows = await db
        .selectFrom('skills_v1_user_skills')
        .selectAll()
        .where('owner_user_id', '=', ownerUserId)
        .where('skill_id', 'in', skillIds)
        .execute();

      const byId = new Map(rows.map((r) => [r.skill_id, r]));

      // Preserve input order; drop unknown ids silently.
      const result: ResolvedSkill[] = [];
      for (const id of skillIds) {
        const row = byId.get(id);
        if (row === undefined) continue;
        result.push(rowToUserResolved(row, await loadFiles(row.bundle_tree_sha)));
      }
      return result;
    },
  };
}
