/**
 * @ax/skills admit-to-catalog queue store (JIT §6D, §11.6).
 *
 * Persists catalog requests and, for share submissions, an IMMUTABLE bundle
 * SNAPSHOT (manifest_yaml/body_md verbatim + a content-addressed tree SHA over
 * the extra files) so the bytes an admin reviews are exactly the bytes admit
 * promotes — no review-vs-ship drift (design §6D / §9.2). Reuses the SAME
 * shared content-addressed bundleStore the skill stores use (now blob-backed,
 * out-of-git Part D2), so a snapshot dedups against the source skill's own
 * bundle and stays valid even if the author later edits/deletes it.
 *
 * `bundle_tree_sha` is a STORAGE detail — it never leaves this file. Callers
 * see bundles as files[] only (storage-agnostic, invariant I1).
 */
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { SkillsDatabase, CatalogRequestRow } from './migrations.js';
import type { BundleFile } from './bundle-files.js';
import type { BlobBundleStore } from './blob-bundle-store.js';

export interface CatalogRequest {
  requestId: string;
  kind: 'share' | 'cold-start';
  skillId: string;
  requestedByUserId: string;
  /** The user whose editable working copy admit retires. null for cold-start. */
  sourceOwnerUserId: string | null;
  status: 'pending' | 'admitted' | 'rejected';
  description: string;
  createdAt: string; // ISO-8601
  /** Snapshot (share only; null for cold-start). */
  manifestYaml: string | null;
  bodyMd: string | null;
  /** Reconstructed extra files. [] for cold-start or single-file skills. */
  files: BundleFile[];
}

export interface SubmitShareInput {
  skillId: string;
  requestedByUserId: string;
  description: string;
  /** Snapshot bytes, resolved by the plugin from the source user-scoped skill. */
  manifestYaml: string;
  bodyMd: string;
  files: BundleFile[];
}
export interface SubmitColdStartInput {
  skillId: string;
  requestedByUserId: string;
  description: string;
}

export interface CatalogRequestsStore {
  submitShare(input: SubmitShareInput): Promise<{ request: CatalogRequest; created: boolean }>;
  submitColdStart(
    input: SubmitColdStartInput,
  ): Promise<{ request: CatalogRequest; created: boolean }>;
  listPending(): Promise<CatalogRequest[]>;
  get(requestId: string): Promise<CatalogRequest | null>;
  markDecided(
    requestId: string,
    status: 'admitted' | 'rejected',
    decidedByUserId: string,
  ): Promise<void>;
}

export function createCatalogRequestsStore(
  db: Kysely<SkillsDatabase>,
  bundleStore: BlobBundleStore,
): CatalogRequestsStore {
  async function rowToRequest(row: CatalogRequestRow): Promise<CatalogRequest> {
    const files =
      row.bundle_tree_sha === null ? [] : await bundleStore.readTree(row.bundle_tree_sha);
    return {
      requestId: row.request_id,
      kind: row.kind,
      skillId: row.skill_id,
      requestedByUserId: row.requested_by_user_id,
      sourceOwnerUserId: row.source_owner_user_id,
      status: row.status,
      description: row.description,
      createdAt: row.created_at.toISOString(),
      manifestYaml: row.manifest_yaml,
      bodyMd: row.body_md,
      files,
    };
  }

  // Dedup: return the existing pending request for this skill_id if any
  // (SELECT-then-INSERT; the partial unique index is the backstop under races).
  async function existingPending(skillId: string): Promise<CatalogRequestRow | undefined> {
    return db
      .selectFrom('skills_v1_catalog_requests')
      .selectAll()
      .where('skill_id', '=', skillId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
  }

  async function insert(values: {
    kind: 'share' | 'cold-start';
    skillId: string;
    requestedByUserId: string;
    sourceOwnerUserId: string | null;
    description: string;
    manifestYaml: string | null;
    bodyMd: string | null;
    bundleTreeSha: string | null;
  }): Promise<CatalogRequest> {
    const now = new Date();
    const row: CatalogRequestRow = {
      request_id: randomUUID(),
      kind: values.kind,
      skill_id: values.skillId,
      requested_by_user_id: values.requestedByUserId,
      source_owner_user_id: values.sourceOwnerUserId,
      status: 'pending',
      description: values.description,
      manifest_yaml: values.manifestYaml,
      body_md: values.bodyMd,
      bundle_tree_sha: values.bundleTreeSha,
      created_at: now,
      updated_at: now,
      decided_at: null,
      decided_by_user_id: null,
    };
    await db.insertInto('skills_v1_catalog_requests').values(row).execute();
    return rowToRequest(row);
  }

  return {
    async submitShare(input) {
      const dup = await existingPending(input.skillId);
      if (dup !== undefined) return { request: await rowToRequest(dup), created: false };
      // Content-addressed snapshot of the extra files (null when single-file).
      const bundleTreeSha = await bundleStore.writeTree(input.files);
      const request = await insert({
        kind: 'share',
        skillId: input.skillId,
        requestedByUserId: input.requestedByUserId,
        sourceOwnerUserId: input.requestedByUserId, // a user shares their OWN skill
        description: input.description,
        manifestYaml: input.manifestYaml,
        bodyMd: input.bodyMd,
        bundleTreeSha,
      });
      return { request, created: true };
    },

    async submitColdStart(input) {
      const dup = await existingPending(input.skillId);
      if (dup !== undefined) return { request: await rowToRequest(dup), created: false };
      const request = await insert({
        kind: 'cold-start',
        skillId: input.skillId,
        requestedByUserId: input.requestedByUserId,
        sourceOwnerUserId: null,
        description: input.description,
        manifestYaml: null,
        bodyMd: null,
        bundleTreeSha: null,
      });
      return { request, created: true };
    },

    async listPending() {
      const rows = await db
        .selectFrom('skills_v1_catalog_requests')
        .selectAll()
        .where('status', '=', 'pending')
        .orderBy('created_at', 'asc')
        .orderBy('request_id', 'asc')
        .execute();
      const out: CatalogRequest[] = [];
      for (const r of rows) out.push(await rowToRequest(r));
      return out;
    },

    async get(requestId) {
      const row = await db
        .selectFrom('skills_v1_catalog_requests')
        .selectAll()
        .where('request_id', '=', requestId)
        .executeTakeFirst();
      return row === undefined ? null : rowToRequest(row);
    },

    async markDecided(requestId, status, decidedByUserId) {
      await db
        .updateTable('skills_v1_catalog_requests')
        .set({
          status,
          decided_at: new Date(),
          decided_by_user_id: decidedByUserId,
          updated_at: new Date(),
        })
        .where('request_id', '=', requestId)
        .execute();
    },
  };
}
