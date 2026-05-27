import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { SkillsDatabase } from './migrations.js';
import { createBundleStore, type BundleStore } from './bundle-store.js';
import {
  parseCapabilities,
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
  /**
   * Atomic partial-update: flip ONLY the `default_attached` flag (plus
   * `updated_at`) for an existing skill — never re-writing manifest/body/bundle.
   * This is the race-safe replacement for the PATCH route's old
   * read-full-detail + re-upsert-the-whole-bundle dance: a concurrent SKILL.md
   * edit can no longer be clobbered, because the SELECT … FOR UPDATE + flag-only
   * UPDATE run inside one transaction and we touch only the flag column.
   *
   * When flipping to `true`, the I-S2 constraint is enforced INSIDE the locked
   * transaction (default-attached skills must be instruction-only): the locked
   * row's manifest is re-parsed and a credential-bearing skill throws
   * `Error('default-attached-requires-no-credentials: …')` — the plugin layer
   * re-wraps it as the matching `PluginError`.
   *
   * Returns `{ found, defaultAttached }`: `found:false` (no row) lets the caller
   * 404 without a separate read.
   */
  setDefaultAttached(
    skillId: string,
    defaultAttached: boolean,
  ): Promise<{ found: boolean; defaultAttached: boolean }>;
}

export function createSkillsStore(
  db: Kysely<SkillsDatabase>,
  // The content-addressed bundle byte-store. Optional so the existing
  // `createSkillsStore(db)` unit-test call sites keep working — they get a
  // fresh ephemeral repo (each test upserts+reads on one store instance).
  // Production wires a durable repo via the plugin (Task 5).
  bundleStore: BundleStore = createBundleStore(mkdtempSync(join(tmpdir(), 'ax-skills-bundles-'))),
): SkillsStore {
  // ---- bundle extra-file helpers (content-addressed git tree byte-store) ----

  // Load a single skill's extra files from its tree SHA (NULL → []). The
  // git-extract boundary (bundle-store readTree) re-validates modes + paths.
  async function loadFiles(treeSha: string | null): Promise<BundleFile[]> {
    return treeSha === null ? [] : bundleStore.readTree(treeSha);
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

      return rowToGlobalDetail(row, await loadFiles(row.bundle_tree_sha));
    },

    async upsert(input) {
      // Write the extra-file tree FIRST (only when `files` is explicitly
      // provided). `undefined` = leave the current bundle unchanged (the
      // metadata-only admin/settings/refresh routes send no `files`; treating
      // that as [] would wipe a multi-file bundle on a body edit — the §6D
      // data-loss bug). An explicit `[]` → null SHA → cleared bundle.
      const filesProvided = input.files !== undefined;
      const treeSha = filesProvided ? await bundleStore.writeTree(input.files!) : null;

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
            // null when no files provided on create (single-file skill).
            bundle_tree_sha: treeSha,
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
            // Only touch bundle_tree_sha when `files` was explicitly provided —
            // a metadata-only edit must NOT wipe the bundle (§6D).
            ...(filesProvided ? { bundle_tree_sha: treeSha } : {}),
            updated_at: new Date(),
          })
          .where('skill_id', '=', input.id)
          .execute();
      }
      return { created };
    },

    async delete(skillId) {
      // Silent if the id doesn't exist — the plugin layer adds the not-found
      // error when needed. The store is the dumb persistence layer. Just delete
      // the row: orphaned bundle tree/blobs are content-addressed (dedup-shared,
      // GC-reclaimable) — no explicit cleanup needed at the admin (~10 skills)
      // scale.
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

      // Per-row readTree over the (≤ ~10) default ids — in-process git object
      // reads, no DB N+1 (the bytes already live in the bundle repo).
      const out: ResolvedSkill[] = [];
      for (const r of rows) {
        out.push(rowToGlobalResolved(r, await loadFiles(r.bundle_tree_sha)));
      }
      return out;
    },

    async setDefaultAttached(skillId, defaultAttached) {
      // Single transaction with a row-level lock (FOR UPDATE) so the
      // read-the-manifest / enforce-I-S2 / flip-the-flag sequence is atomic.
      // A concurrent SKILL.md edit (skills:upsert) either commits before our
      // SELECT (we then read its manifest) or blocks on the lock until we
      // commit — and because we only UPDATE the flag column, we can never
      // clobber a manifest/body edit (the old get+upsert PATCH race).
      // Mirrors @ax/onboarding store.resetToPending's txn + .forUpdate() shape.
      return db.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom('skills_v1_skills')
          .select(['skill_id', 'manifest_yaml'])
          .where('skill_id', '=', skillId)
          .forUpdate()
          .executeTakeFirst();

        if (row === undefined) {
          return { found: false, defaultAttached };
        }

        // I-S2: default-attached skills are instruction-only — a skill that
        // declares credential slots can't be "everyone gets this". Enforced
        // inside the lock against the row's own (just-read) manifest so a
        // concurrent edit that adds slots can't slip a credentialed skill into
        // the defaults set. The plugin layer re-wraps this Error as the
        // matching PluginError (single source of truth for the code string).
        if (defaultAttached) {
          const caps = parseCapabilities(row.manifest_yaml, skillId);
          if (caps.credentials.length > 0) {
            throw new Error(
              `default-attached-requires-no-credentials: skill '${skillId}' declares ` +
                `credential slots; default-attached skills must be instruction-only`,
            );
          }
        }

        await tx
          .updateTable('skills_v1_skills')
          .set({ default_attached: defaultAttached, updated_at: new Date() })
          .where('skill_id', '=', skillId)
          .execute();

        return { found: true, defaultAttached };
      });
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
        result.push(rowToGlobalResolved(row, await loadFiles(row.bundle_tree_sha)));
      }
      return result;
    },
  };
}
