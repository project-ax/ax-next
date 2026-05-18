import type { Kysely } from 'kysely';
import { parseSkillManifest } from './manifest.js';
import type { SkillsDatabase } from './migrations.js';
import type {
  ResolvedSkill,
  SkillCapabilities,
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
// ---------------------------------------------------------------------------
const EMPTY_CAPABILITIES: SkillCapabilities = { allowedHosts: [], credentials: [] };

function parseCapabilities(manifestYaml: string, skillId: string): SkillCapabilities {
  const result = parseSkillManifest(manifestYaml);
  if (!result.ok) {
    // Use stderr directly — the store doesn't have a logger handle and
    // pulling one in would couple the read path to AgentContext just
    // for this defensive branch. The structured "msg" prefix matches
    // the rest of the codebase's plain-text log convention.
    process.stderr.write(
      `[@ax/skills/store] corrupt_manifest skillId=${JSON.stringify(skillId)} code=${result.code} message=${JSON.stringify(result.message)}\n`,
    );
    return EMPTY_CAPABILITIES;
  }
  return result.value.capabilities;
}

export interface UpsertInput {
  id: string;
  description: string;
  manifestYaml: string;
  bodyMd: string;
  version: number;
}

export interface SkillsStore {
  list(): Promise<SkillSummary[]>;
  get(skillId: string): Promise<SkillDetail | null>;
  upsert(input: UpsertInput): Promise<{ created: boolean }>;
  delete(skillId: string): Promise<void>;
  resolve(skillIds: string[]): Promise<ResolvedSkill[]>;
}

export function createSkillsStore(db: Kysely<SkillsDatabase>): SkillsStore {
  return {
    async list() {
      const rows = await db
        .selectFrom('skills_v1_skills')
        .selectAll()
        .orderBy('skill_id', 'asc')
        .execute();

      return rows.map((row): SkillSummary => ({
        id: row.skill_id,
        description: row.description,
        version: row.version,
        capabilities: parseCapabilities(row.manifest_yaml, row.skill_id),
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async get(skillId) {
      const row = await db
        .selectFrom('skills_v1_skills')
        .selectAll()
        .where('skill_id', '=', skillId)
        .executeTakeFirst();

      if (row === undefined) return null;

      const detail: SkillDetail = {
        id: row.skill_id,
        description: row.description,
        version: row.version,
        capabilities: parseCapabilities(row.manifest_yaml, row.skill_id),
        updatedAt: row.updated_at.toISOString(),
        bodyMd: row.body_md,
        manifestYaml: row.manifest_yaml,
      };
      return detail;
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

      if (existing === undefined) {
        const now = new Date();
        await db
          .insertInto('skills_v1_skills')
          .values({
            skill_id: input.id,
            description: input.description,
            manifest_yaml: input.manifestYaml,
            body_md: input.bodyMd,
            version: input.version,
            created_at: now,
            updated_at: now,
          })
          .execute();
        return { created: true };
      }

      await db
        .updateTable('skills_v1_skills')
        .set({
          description: input.description,
          manifest_yaml: input.manifestYaml,
          body_md: input.bodyMd,
          version: input.version,
          updated_at: new Date(),
        })
        .where('skill_id', '=', input.id)
        .execute();
      return { created: false };
    },

    async delete(skillId) {
      // Silent if the id doesn't exist — the plugin layer adds the not-found
      // error when needed. The store is the dumb persistence layer.
      await db
        .deleteFrom('skills_v1_skills')
        .where('skill_id', '=', skillId)
        .execute();
    },

    async resolve(skillIds) {
      if (skillIds.length === 0) return [];

      const rows = await db
        .selectFrom('skills_v1_skills')
        .selectAll()
        .where('skill_id', 'in', skillIds)
        .execute();

      const byId = new Map(rows.map((r) => [r.skill_id, r]));

      // Preserve input order; drop unknown ids silently.
      const result: ResolvedSkill[] = [];
      for (const id of skillIds) {
        const row = byId.get(id);
        if (row === undefined) continue;
        result.push({
          id: row.skill_id,
          capabilities: parseCapabilities(row.manifest_yaml, row.skill_id),
          bodyMd: row.body_md,
          manifestYaml: row.manifest_yaml,
        });
      }
      return result;
    },
  };
}
