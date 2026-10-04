/**
 * @ax/skills blob-reference lookup (TASK-776, blob-gc design D2/D7).
 *
 * Four tables point at a bundle's content-addressed blob through a column named
 * `bundle_tree_sha` (the name is a leftover from the git-tree backing; the value
 * is a blob sha256). This answers one question for the `blob:collect-refs`
 * holder: of these candidate shas, which do our rows still reference, and for
 * whom?
 *
 *   skills_v1_skills           admin-managed, system-wide   -> nobody in particular
 *   skills_v1_user_skills      a user's own editable copy   -> owner_user_id
 *   skills_v1_authored         an agent-authored draft      -> owner_user_id
 *   skills_v1_catalog_requests a share snapshot             -> source_owner_user_id
 *                                                              when set, else nobody
 *
 * `userIds: []` means "held, but not by a person": the bytes are kept and no
 * ledger charge is released for them. A catalog request keeps its snapshot
 * whatever its status — a rejected or admitted request is still a row that
 * points at the bytes, and a missed reference deletes someone's skill.
 *
 * `skills_v1_skill_files` is deliberately absent: it carries no sha column (the
 * migration test pins its columns), so it cannot hold a blob.
 *
 * Every query throws on failure. The holder turns a throw into `ok: false`;
 * swallowing one here would read as "no references" and let a sweep delete live
 * bundles.
 */
import { sql, type Kysely } from 'kysely';
import type { BlobRef } from '@ax/core';
import type { SkillsDatabase } from './migrations.js';

export async function collectBundleRefs(
  db: Kysely<SkillsDatabase>,
  shas: string[],
): Promise<BlobRef[]> {
  if (shas.length === 0) return [];
  // `= ANY(array)` rather than IN (...): one bind parameter however many
  // candidates there are, and it uses the bundle_tree_sha indexes.
  const refs: BlobRef[] = [];

  const global = await db
    .selectFrom('skills_v1_skills')
    .select('bundle_tree_sha')
    .where(sql<boolean>`bundle_tree_sha = ANY(${shas}::text[])`)
    .execute();
  for (const r of global) {
    if (r.bundle_tree_sha !== null) refs.push({ sha256: r.bundle_tree_sha, userIds: [] });
  }

  const userScoped = await db
    .selectFrom('skills_v1_user_skills')
    .select(['bundle_tree_sha', 'owner_user_id'])
    .where(sql<boolean>`bundle_tree_sha = ANY(${shas}::text[])`)
    .execute();
  for (const r of userScoped) {
    if (r.bundle_tree_sha !== null) {
      refs.push({ sha256: r.bundle_tree_sha, userIds: [r.owner_user_id] });
    }
  }

  const authored = await db
    .selectFrom('skills_v1_authored')
    .select(['bundle_tree_sha', 'owner_user_id'])
    .where(sql<boolean>`bundle_tree_sha = ANY(${shas}::text[])`)
    .execute();
  for (const r of authored) {
    if (r.bundle_tree_sha !== null) {
      refs.push({ sha256: r.bundle_tree_sha, userIds: [r.owner_user_id] });
    }
  }

  const requests = await db
    .selectFrom('skills_v1_catalog_requests')
    .select(['bundle_tree_sha', 'source_owner_user_id'])
    .where(sql<boolean>`bundle_tree_sha = ANY(${shas}::text[])`)
    .execute();
  for (const r of requests) {
    if (r.bundle_tree_sha === null) continue;
    const owner = r.source_owner_user_id;
    refs.push({
      sha256: r.bundle_tree_sha,
      userIds: owner !== null && owner.length > 0 ? [owner] : [],
    });
  }

  return refs;
}
