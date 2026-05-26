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
import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';
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

export function createUserSkillsStore(db: Kysely<SkillsDatabase>): UserSkillsStore {
  // ---- bundle extra-file helpers (user scope: scope='user', owner=user id) ----

  async function loadFiles(ownerUserId: string, skillId: string): Promise<BundleFile[]> {
    const rows = await db
      .selectFrom('skills_v1_skill_files')
      .select(['path', 'contents'])
      .where('scope', '=', 'user')
      .where('owner_user_id', '=', ownerUserId)
      .where('skill_id', '=', skillId)
      .orderBy('path')
      .execute();
    return rows.map((r) => ({ path: r.path, contents: r.contents }));
  }

  async function loadFilesFor(
    ownerUserId: string,
    skillIds: string[],
  ): Promise<Map<string, BundleFile[]>> {
    const grouped = new Map<string, BundleFile[]>();
    if (skillIds.length === 0) return grouped;
    const rows = await db
      .selectFrom('skills_v1_skill_files')
      .select(['skill_id', 'path', 'contents'])
      .where('scope', '=', 'user')
      .where('owner_user_id', '=', ownerUserId)
      .where('skill_id', 'in', skillIds)
      .orderBy('skill_id')
      .orderBy('path')
      .execute();
    for (const r of rows) {
      const list = grouped.get(r.skill_id) ?? [];
      list.push({ path: r.path, contents: r.contents });
      grouped.set(r.skill_id, list);
    }
    return grouped;
  }

  async function replaceFiles(
    ownerUserId: string,
    skillId: string,
    files: BundleFile[],
  ): Promise<void> {
    await db
      .deleteFrom('skills_v1_skill_files')
      .where('scope', '=', 'user')
      .where('owner_user_id', '=', ownerUserId)
      .where('skill_id', '=', skillId)
      .execute();
    if (files.length > 0) {
      await db
        .insertInto('skills_v1_skill_files')
        .values(
          files.map((f) => ({
            scope: 'user' as const,
            owner_user_id: ownerUserId,
            skill_id: skillId,
            path: f.path,
            contents: f.contents,
          })),
        )
        .execute();
    }
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
      return rowToUserDetail(row, ownerUserId, await loadFiles(ownerUserId, skillId));
    },

    async upsert(input) {
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
            updated_at: new Date(),
          })
          .where('owner_user_id', '=', input.ownerUserId)
          .where('skill_id', '=', input.id)
          .execute();
      }

      // Replace the extra-file set ONLY when `files` is explicitly provided
      // (scoped to this user). `undefined` = leave current files unchanged —
      // see the store.ts rationale (the §6D metadata-only-edit data-loss bug).
      if (input.files !== undefined) {
        await replaceFiles(input.ownerUserId, input.id, input.files);
      } else if (created) {
        await replaceFiles(input.ownerUserId, input.id, []);
      }
      return { created };
    },

    async delete(ownerUserId, skillId) {
      // Silent if the row doesn't exist — the plugin layer adds the not-found
      // error when needed. The store is the dumb persistence layer. Also drop
      // the skill's extra files so a later re-create starts from a clean set.
      await replaceFiles(ownerUserId, skillId, []);
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

      const filesById = await loadFilesFor(ownerUserId, rows.map((r) => r.skill_id));
      return rows.map((r) => rowToUserResolved(r, filesById.get(r.skill_id) ?? []));
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
      const filesById = await loadFilesFor(ownerUserId, rows.map((r) => r.skill_id));

      // Preserve input order; drop unknown ids silently.
      const result: ResolvedSkill[] = [];
      for (const id of skillIds) {
        const row = byId.get(id);
        if (row === undefined) continue;
        result.push(rowToUserResolved(row, filesById.get(id) ?? []));
      }
      return result;
    },
  };
}
