/**
 * @ax/skills authored-skills store (TASK-74, out-of-git Part D).
 *
 * The single source of truth for agent-authored skills, replacing the
 * `.ax/draft-skills/<id>/` git workspace. Operates on `skills_v1_authored`,
 * scoped to `(owner_user_id, agent_id)` — the per-(user, agent) draft namespace.
 *
 * The hybrid materialization gate (design §D3) classifies a proposal at write
 * time into one of three `status` values; this store just persists the verdict
 * and reads back the agent's rows for the projection. Extra (non-SKILL.md)
 * bundle files ride the shared content-addressed bundle byte-store (blob),
 * exactly like the global/user skill stores — one storage path (I4).
 */
import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';
import {
  createInMemoryBundleStore,
  type BlobBundleStore,
} from './blob-bundle-store.js';
import type { BundleFile } from './types.js';

export type AuthoredStatus = 'active' | 'pending' | 'quarantined';
export type AuthoredOrigin = 'authored' | 'imported' | 'attached';

export interface AuthoredSkill {
  ownerUserId: string;
  agentId: string;
  skillId: string;
  description: string;
  manifestYaml: string;
  bodyMd: string;
  origin: AuthoredOrigin;
  status: AuthoredStatus;
  scanVerdict: string | null;
  files: BundleFile[];
  updatedAt: string;
}

export interface UpsertAuthoredInput {
  ownerUserId: string;
  agentId: string;
  skillId: string;
  description: string;
  manifestYaml: string;
  bodyMd: string;
  origin: AuthoredOrigin;
  status: AuthoredStatus;
  scanVerdict: string | null;
  files: BundleFile[];
}

export interface AuthoredSkillsStore {
  /** Insert or replace one authored skill row (last-write-wins per draft). */
  upsert(input: UpsertAuthoredInput): Promise<{ created: boolean }>;
  /** List the agent's authored skills (any status), sorted by skill_id. The
   * projection caller filters by status; quarantined rows are returned so a
   * reason can be surfaced, but the projection omits them. */
  list(ownerUserId: string, agentId: string): Promise<AuthoredSkill[]>;
  /** Flip a `pending` row to `active` (design §D3 — on approval). Status-guarded:
   * the UPDATE matches `status = 'pending'` only, so a `quarantined` row is never
   * un-quarantined and an already-`active` row is a no-op. Returns whether THIS
   * call flipped a row (false = already active / quarantined / no such row). */
  activate(input: {
    ownerUserId: string;
    agentId: string;
    skillId: string;
  }): Promise<{ activated: boolean }>;
}

function rowToAuthored(
  row: SkillsDatabase['skills_v1_authored'],
  files: BundleFile[],
): AuthoredSkill {
  return {
    ownerUserId: row.owner_user_id,
    agentId: row.agent_id,
    skillId: row.skill_id,
    description: row.description,
    manifestYaml: row.manifest_yaml,
    bodyMd: row.body_md,
    origin: row.origin as AuthoredOrigin,
    status: row.status as AuthoredStatus,
    scanVerdict: row.scan_verdict,
    files,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createAuthoredSkillsStore(
  db: Kysely<SkillsDatabase>,
  bundleStore: BlobBundleStore = createInMemoryBundleStore(),
): AuthoredSkillsStore {
  async function loadFiles(treeSha: string | null): Promise<BundleFile[]> {
    return treeSha === null ? [] : bundleStore.readTree(treeSha);
  }

  return {
    async upsert(input) {
      // Write the extra-file tree FIRST (content-addressed; identical bytes
      // dedup against any other skill's bundle). A draft with no extra files
      // gets a NULL pointer.
      const treeSha =
        input.files.length > 0 ? await bundleStore.writeTree(input.files) : null;

      const existing = await db
        .selectFrom('skills_v1_authored')
        .select('skill_id')
        .where('owner_user_id', '=', input.ownerUserId)
        .where('agent_id', '=', input.agentId)
        .where('skill_id', '=', input.skillId)
        .executeTakeFirst();

      const created = existing === undefined;
      const now = new Date();
      if (created) {
        await db
          .insertInto('skills_v1_authored')
          .values({
            owner_user_id: input.ownerUserId,
            agent_id: input.agentId,
            skill_id: input.skillId,
            description: input.description,
            manifest_yaml: input.manifestYaml,
            body_md: input.bodyMd,
            bundle_tree_sha: treeSha,
            origin: input.origin,
            status: input.status,
            scan_verdict: input.scanVerdict,
            created_at: now,
            updated_at: now,
          })
          .execute();
      } else {
        // Re-propose REPLACES the row (last-write-wins per draft): a new
        // bundle, fresh gate verdict. bundle_tree_sha is always rewritten —
        // a re-propose carries the full current bundle.
        await db
          .updateTable('skills_v1_authored')
          .set({
            description: input.description,
            manifest_yaml: input.manifestYaml,
            body_md: input.bodyMd,
            bundle_tree_sha: treeSha,
            origin: input.origin,
            status: input.status,
            scan_verdict: input.scanVerdict,
            updated_at: now,
          })
          .where('owner_user_id', '=', input.ownerUserId)
          .where('agent_id', '=', input.agentId)
          .where('skill_id', '=', input.skillId)
          .execute();
      }
      return { created };
    },

    async list(ownerUserId, agentId) {
      const rows = await db
        .selectFrom('skills_v1_authored')
        .selectAll()
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .orderBy('skill_id', 'asc')
        .execute();
      const out: AuthoredSkill[] = [];
      for (const r of rows) out.push(rowToAuthored(r, await loadFiles(r.bundle_tree_sha)));
      return out;
    },

    async activate({ ownerUserId, agentId, skillId }) {
      // Status-guarded flip: only a `pending` row transitions. A `quarantined`
      // row is left alone (approval must never un-quarantine a flagged bundle),
      // and an already-`active` row is a no-op. The `status = 'pending'` predicate
      // also makes the call idempotent + race-safe (a concurrent duplicate
      // approval flips zero rows the second time).
      const res = await db
        .updateTable('skills_v1_authored')
        .set({ status: 'active', updated_at: new Date() })
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('skill_id', '=', skillId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      return { activated: Number(res.numUpdatedRows ?? 0n) > 0 };
    },
  };
}
