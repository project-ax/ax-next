import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';
import {
  rowToGlobalDetail,
  rowToGlobalResolved,
  rowToGlobalSummary,
} from './_row-mappers.js';
import type {
  BundleFile,
  ResolvedSkill,
  SkillDetail,
  SkillSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// Capability re-parse on read.
//
// `skills:upsert` validates the manifest at write time via parseSkillManifest;
// the row's `manifest_yaml` is the canonical store. On read we re-parse
// rather than denormalize into separate JSONB columns — for the v1
// admin-managed scale (~10s of skills), the parse cost is negligible.
//
// Defensive fallback for parse-failure: log loud (stderr) but DO NOT throw.
// A corrupt row would otherwise crash skills:list and freeze the admin UI;
// the design doc explicitly tolerates this state (a `skills:resolve` of a
// silently-malformed row drops it from the union, matching the "deleted-
// skill-still-attached" policy). The loud log lets the operator find and
// fix the row; the empty caps keep the rest of the system live.
//
// The actual parseCapabilities helper and row mappers live in _row-mappers.ts
// so both store.ts and user-store.ts share the same logic (DRY without
// violating I4 — the mapper module is internal to @ax/skills).
// ---------------------------------------------------------------------------

export interface UpsertInput {
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

export interface SkillsStore {
  list(): Promise<SkillSummary[]>;
  get(skillId: string): Promise<SkillDetail | null>;
  upsert(input: UpsertInput): Promise<{ created: boolean }>;
  delete(skillId: string): Promise<void>;
  resolve(skillIds: string[]): Promise<ResolvedSkill[]>;
  getDefaults(): Promise<ResolvedSkill[]>;
}

export function createSkillsStore(db: Kysely<SkillsDatabase>): SkillsStore {
  // ---- bundle extra-file helpers (global scope: scope='global', owner='') ----

  // Load a single skill's extra files, ordered by path for determinism.
  async function loadFiles(skillId: string): Promise<BundleFile[]> {
    const rows = await db
      .selectFrom('skills_v1_skill_files')
      .select(['path', 'contents'])
      .where('scope', '=', 'global')
      .where('owner_user_id', '=', '')
      .where('skill_id', '=', skillId)
      .orderBy('path')
      .execute();
    return rows.map((r) => ({ path: r.path, contents: r.contents }));
  }

  // Batched load for resolve/getDefaults — one query, grouped by skill_id, to
  // avoid an N+1 fan-out over the resolved id list.
  async function loadFilesFor(skillIds: string[]): Promise<Map<string, BundleFile[]>> {
    const grouped = new Map<string, BundleFile[]>();
    if (skillIds.length === 0) return grouped;
    const rows = await db
      .selectFrom('skills_v1_skill_files')
      .select(['skill_id', 'path', 'contents'])
      .where('scope', '=', 'global')
      .where('owner_user_id', '=', '')
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

  // Replace a skill's full extra-file set (delete-then-insert). Called inside
  // upsert so a re-upsert with a new file set fully supersedes the old one.
  async function replaceFiles(skillId: string, files: BundleFile[]): Promise<void> {
    await db
      .deleteFrom('skills_v1_skill_files')
      .where('scope', '=', 'global')
      .where('owner_user_id', '=', '')
      .where('skill_id', '=', skillId)
      .execute();
    if (files.length > 0) {
      await db
        .insertInto('skills_v1_skill_files')
        .values(
          files.map((f) => ({
            scope: 'global' as const,
            owner_user_id: '',
            skill_id: skillId,
            path: f.path,
            contents: f.contents,
          })),
        )
        .execute();
    }
  }

  return {
    async list() {
      const rows = await db
        .selectFrom('skills_v1_skills')
        .selectAll()
        .orderBy('skill_id', 'asc')
        .execute();

      return rows.map(rowToGlobalSummary);
    },

    async get(skillId) {
      const row = await db
        .selectFrom('skills_v1_skills')
        .selectAll()
        .where('skill_id', '=', skillId)
        .executeTakeFirst();

      if (row === undefined) return null;

      return rowToGlobalDetail(row, await loadFiles(skillId));
    },

    async upsert(input) {
      // SELECT → INSERT or UPDATE round-trip so `created` is accurate.
      // PRIMARY KEY guards against concurrency races — a race to insert
      // the same skill_id would surface as a unique-violation; that's
      // acceptable at the admin (~10 skills) scale.
      const existing = await db
        .selectFrom('skills_v1_skills')
        .select('skill_id')
        .where('skill_id', '=', input.id)
        .executeTakeFirst();

      const created = existing === undefined;
      if (created) {
        const now = new Date();
        await db
          .insertInto('skills_v1_skills')
          .values({
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
          .updateTable('skills_v1_skills')
          .set({
            description: input.description,
            manifest_yaml: input.manifestYaml,
            body_md: input.bodyMd,
            version: input.version,
            default_attached: input.defaultAttached ?? false,
            source_url: input.sourceUrl ?? null,
            updated_at: new Date(),
          })
          .where('skill_id', '=', input.id)
          .execute();
      }

      // Replace the full extra-file set on every upsert (insert OR update) so a
      // re-upsert with a new file set supersedes the old one byte-for-byte.
      await replaceFiles(input.id, input.files ?? []);
      return { created };
    },

    async delete(skillId) {
      // Silent if the id doesn't exist — the plugin layer adds the not-found
      // error when needed. The store is the dumb persistence layer. Also drop
      // the skill's extra files so a later re-create starts from a clean set.
      await replaceFiles(skillId, []);
      await db
        .deleteFrom('skills_v1_skills')
        .where('skill_id', '=', skillId)
        .execute();
    },

    async getDefaults() {
      const rows = await db
        .selectFrom('skills_v1_skills')
        .selectAll()
        .where('default_attached', '=', true)
        .orderBy('skill_id', 'asc')
        .execute();

      const filesById = await loadFilesFor(rows.map((r) => r.skill_id));
      return rows.map((r) => rowToGlobalResolved(r, filesById.get(r.skill_id) ?? []));
    },

    async resolve(skillIds) {
      if (skillIds.length === 0) return [];

      const rows = await db
        .selectFrom('skills_v1_skills')
        .selectAll()
        .where('skill_id', 'in', skillIds)
        .execute();

      const byId = new Map(rows.map((r) => [r.skill_id, r]));
      const filesById = await loadFilesFor(rows.map((r) => r.skill_id));

      // Preserve input order; drop unknown ids silently.
      const result: ResolvedSkill[] = [];
      for (const id of skillIds) {
        const row = byId.get(id);
        if (row === undefined) continue;
        result.push(rowToGlobalResolved(row, filesById.get(id) ?? []));
      }
      return result;
    },
  };
}
