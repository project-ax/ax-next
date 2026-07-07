// Consolidator — heart of Phase 2A. Walks the inbox, groups by subject,
// deduplicates against existing doc facts, promotes high-confidence
// observations to `docs/<category>/<slug>.md`, quarantines sensitive
// observations (I11 extension), decays aged-out observations (I14), and
// regenerates `system/recent.md` (I13) + `system/map.md` (TASK-190).
//
// WHY this is one function rather than spread across callers: the entire
// pipeline is a read-then-write pass over the inbox, and its correctness
// depends on ordering (decay → cluster → decide → dedup → write → delete).
// Splitting it across call sites would make the ordering implicit and
// impossible to test end-to-end in a single fixture.
//
// Invariant I12: docs/ is the single source of truth. Promoted inbox files
// are DELETED — never left on disk alongside their doc counterpart.
//
// Invariant I11 (extension): sensitive observations that slip past Phase 1's
// write-time gate are MOVED to `permanent/memory/quarantine/<original-name>`
// for forensics — not deleted, so an operator can investigate how the content
// bypassed the Phase 1 gate. A `memory_strata_promotion_quarantined` log line
// is emitted for each quarantine move.

import { mkdir, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentContext, HookBus } from '@ax/core';
import { clusterBySubject } from './cluster.js';
import { isDupe } from './dedup.js';
import {
  appendFact, formatFactLine, mergeConversationIntoDoc, readDoc, stripFactDate, writeNewDoc,
} from './doc-store.js';
import { deleteInboxFile, listInbox } from './inbox-store.js';
import { decidePromotion } from './promotion.js';
import { regenerateRecent } from './recent.js';
import { regenerateMap, type MapDensifier } from './map.js';
import { categoryDir, MEMORY_ROOT, type DocCategory } from './paths.js';
import { findNearDupSlug } from './slug-guard.js';
import { runRollupPass, type RollupConfig, type StageBNamer } from './rollup.js';

/**
 * Categories a rollup class can be built over (TASK-200). Mirrors
 * `DEFAULT_ROLLUP_CONFIG.enumerableCategories` — the consolidator's dirty gate
 * only runs the rollup pass when a fact was promoted/merged into one of these.
 * `preference`/`decision` are single-state (not enumerable).
 */
const ENUMERABLE_CATEGORIES: ReadonlySet<DocCategory> = new Set<DocCategory>([
  'episode', 'entity', 'general',
]);

/**
 * Minimal structured-logger interface the consolidator uses. The caller
 * provides a real logger (pino, etc.) or leaves it undefined to get a
 * no-op implementation. Keeping this local avoids pulling @ax/core into
 * a package that must stay storage-agnostic.
 */
export interface ConsolidationLogger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
}

export interface ConsolidationInput {
  workspaceRoot: string;
  now: Date;
  logger?: ConsolidationLogger;
  /**
   * Optional bus + ctx for publishing memory:doc:written events. When
   * absent, no events fire (test-driveable without a bus). When present,
   * a memory:doc:written event fires after each successful writeNewDoc
   * (kind:'created') and appendFact (kind:'updated').
   */
  bus?: HookBus;
  ctx?: AgentContext;
  /**
   * Optional host-LLM densifier for `system/map.md` (TASK-190). When provided,
   * each doc's map one-liner is densified via the host LLM (same gating as the
   * Observer) and cached incrementally. When absent — CI without keys, or the
   * provider is unavailable — `regenerateMap` falls back to each doc's raw
   * frontmatter summary, so the map is ALWAYS regenerated, just without the
   * LLM-densified one-liners.
   */
  densifyMap?: MapDensifier | undefined;
  /**
   * Optional rollup-pass config override (TASK-200). Omitted in production — the
   * pass uses `DEFAULT_ROLLUP_CONFIG` (K=3, salience 0.4, cap 50). Tests thread
   * a smaller K etc. through here to drive edge cases deterministically.
   */
  rollupConfig?: RollupConfig | undefined;
  /**
   * Optional Stage-B LLM class namer (TASK-201). When provided, the rollup pass
   * runs bounded LLM naming over the RESIDUE (enumerable docs Stage A did not
   * claim) in addition to Stage A. Omitted in tests and when no LLM is wired —
   * the pass then runs Stage A only (graceful degradation, mirrors `densifyMap`).
   * Built HERE by the plugin (closing over `llm:call` + the fixed extraction
   * model) so the tier path — which runs the pass without a bus — can still name.
   */
  rollupStageB?: StageBNamer | undefined;
}

export interface ConsolidationResult {
  /** Inbox files successfully promoted to docs/. */
  promoted: number;
  /** Inbox files whose summary was a near-duplicate of an existing doc fact. */
  dupesMerged: number;
  /** Inbox files quarantined by the I11 promotion-time sensitive gate. */
  quarantined: number;
  /** Inbox files left in place (e.g. confidence below threshold). */
  leftInInbox: number;
  /** Inbox files deleted because they aged past the decay window. */
  decayed: number;
  /** Rollup docs written/rewritten this pass (TASK-200). 0 when the dirty gate
   *  skipped the rollup pass (no enumerable-category write). */
  rollupsWritten: number;
  /** Qualifying rollups whose content was unchanged (skipped, idempotent). */
  rollupsSkipped: number;
  /**
   * docIds of rollups GC'd this pass (`rollup/<slug>`). On the CLI/direct path
   * their `memory:doc:deleted` events already fired inline; the tier path (which
   * runs the pass without a bus) re-fires them after flush.
   */
  rollupsDeleted: string[];
}

/** Quarantine directory path relative to workspaceRoot. */
const QUARANTINE_DIR = `${MEMORY_ROOT}/quarantine`;

/** Observations older than this many days are decayed (I14). */
const DECAY_DAYS = 14;

/**
 * Run one full consolidation pass over the workspace's inbox.
 *
 * Step order (deliberate):
 *   1. Decay aged observations (so they are never clustered or promoted).
 *   2. List remaining inbox observations + cluster by subject.
 *   3. For each cluster, for each observation: decide → dedup → write/skip.
 *   4. Regenerate system/recent.md (I13).
 *
 * @returns Numeric audit of the pass: promoted / dupesMerged / quarantined /
 *          leftInInbox / decayed.
 */
export async function runConsolidation(
  input: ConsolidationInput,
): Promise<ConsolidationResult> {
  const log = input.logger ?? noopLogger();

  // Declare counters at function scope so the failure-path catch can
  // include the partial audit context (C2 fix).
  let promoted = 0;
  let dupesMerged = 0;
  let quarantined = 0;
  let leftInInbox = 0;
  let decayed = 0;
  let rollupsWritten = 0;
  let rollupsSkipped = 0;
  let rollupsDeleted: string[] = [];
  // TASK-200 dirty gate: the `promoted`/`dupesMerged` counters are
  // category-agnostic, so track separately whether ANY fact was promoted/merged
  // into an ENUMERABLE-category doc this pass. The rollup pass runs only then —
  // a pass that only touched preferences/decisions can't change any class.
  let enumerableWrite = false;

  try {
    ({ decayed } = await decayInbox(input.workspaceRoot, input.now, log));

    const inbox = await listInbox(input.workspaceRoot);
    const clusters = clusterBySubject(inbox);

    for (const cluster of clusters) {
      // D4 (enumeration design): if a same-category doc already exists whose
      // slug is a token-subset near-dup of this cluster's (b-29-bomber-model
      // vs b-29-bomber-model-kit), append there instead of minting a sibling —
      // duplicate docs inflate enumeration counts. The slug is redirected
      // eagerly (readDoc below must target the near-dup doc), but the merge is
      // only LOGGED after a real write/merge occurs for this cluster this pass:
      // a cluster whose observations never promote (low-confidence, quarantined)
      // must not emit a phantom-merge line that corrupts the very metric this
      // feature exists to expose.
      const originalSlug = cluster.slug;
      const slugsInCategory = await listCategorySlugs(input.workspaceRoot, cluster.category);
      // An exact-slug doc wins over a near-dup (TASK-202). In a LEGACY workspace
      // that already holds BOTH b-29-bomber-model AND b-29-bomber-model-kit
      // (created before #379, no migration), a new b-29-bomber-model cluster must
      // append to its OWN exact doc — findNearDupSlug skips the exact match, so
      // without this guard the cluster is misrouted into the -kit sibling. Only
      // redirect when the exact doc does NOT already exist. (Keeping nearDup null
      // in that case also suppresses the phantom near-dup-merge log below.)
      const nearDup = slugsInCategory.includes(originalSlug)
        ? null
        : findNearDupSlug(cluster.slug, slugsInCategory);
      if (nearDup !== null) {
        cluster.slug = nearDup;
      }
      // Snapshot the pass-global write counters so we can tell, after this
      // cluster's observation loop, whether the redirect actually led to a
      // write/merge into the existing doc.
      const promotedBefore = promoted;
      const dupesMergedBefore = dupesMerged;

      const existing = await readDoc({
        workspaceRoot: input.workspaceRoot,
        category: cluster.category,
        slug: cluster.slug,
      });
      const existingFacts = existing
        ? extractFactsFromBody(existing.body).map(stripFactDate)
        : [];

      // Track whether we've created the doc during this cluster pass so we
      // know whether to call writeNewDoc (first observation) or appendFact
      // (subsequent observations).
      let docCreated = existing !== null;
      const factsInDoc = [...existingFacts];

      for (const obs of cluster.observations) {
        const decision = decidePromotion(obs);

        // Non-promote: two cases — low-confidence (leave in inbox for next pass)
        // or sensitive (quarantine, I11). The decision discriminator picks which.
        if (!decision.promote) {
          if (decision.reason === 'low-confidence') {
            // Not yet ready — leave it in the inbox for the next pass.
            leftInInbox += 1;
            continue;
          }
          // I11: sensitive at promotion-time → quarantine, not delete.
          await quarantineFile(input.workspaceRoot, obs.path);
          log.warn('memory_strata_promotion_quarantined', {
            inboxPath: obs.path,
            kinds: decision.kinds,
          });
          quarantined += 1;
          continue;
        }

        // I12: dedup against facts already in the doc (or accumulated this pass).
        if (isDupe(obs.frontmatter.summary ?? '', factsInDoc)) {
          dupesMerged += 1;
          // TASK-200 dirty gate: a merge into an enumerable-category doc can
          // change a class's member content (its representative fact), so it
          // counts toward running the rollup pass.
          if (ENUMERABLE_CATEGORIES.has(cluster.category)) enumerableWrite = true;
          // TASK-187: a recurring procedure restates a fact already in the doc,
          // so we don't append it — but it recurred, possibly in a NEW
          // conversation. Fold its conversation id into the doc's distinct set
          // BEFORE deleting the inbox file, or a procedure whose recurrence
          // shows up as a near-duplicate summary would never reach the ≥2 gate.
          // (A doc always exists here: dedup only matches once a fact is in it.)
          try {
            await mergeConversationIntoDoc({
              workspaceRoot: input.workspaceRoot,
              category: cluster.category,
              slug: cluster.slug,
              conversationId: obs.frontmatter.conversation_id,
              now: input.now,
            });
          } catch (err) {
            // Non-fatal: a missing doc here is a programming-error signal, but
            // we'd rather log + continue the pass than abort all promotions.
            log.warn('memory_strata_dedup_conversation_merge_failed', {
              err: err instanceof Error ? err : new Error(String(err)),
              docId: `${cluster.category}/${cluster.slug}`,
            });
          }
          await deleteInboxFile(input.workspaceRoot, obs.path);
          continue;
        }

        // Promote: write or append, then delete the inbox source file (I12).
        if (!docCreated) {
          await writeNewDoc({
            workspaceRoot: input.workspaceRoot,
            category: cluster.category,
            slug: cluster.slug,
            summary: obs.frontmatter.summary ?? '',
            subject: obs.frontmatter.subject ?? cluster.slug,
            factType: obs.frontmatter.factType ?? 'general',
            confidence: obs.frontmatter.confidence ?? 0,
            sourceObservationIds: [obs.frontmatter.id],
            // TASK-187: seed the doc's distinct-conversation set so the
            // skill-reflection recurrence gate can read it straight from the doc.
            conversationId: obs.frontmatter.conversation_id,
            now: input.now,
            facts: [
              formatFactLine(
                obs.frontmatter.summary ?? '',
                obs.frontmatter.event_time ?? obs.frontmatter.recorded_at,
              ),
            ],
          });
          docCreated = true;
          if (input.bus !== undefined && input.ctx !== undefined) {
            try {
              await input.bus.fire('memory:doc:written', input.ctx, {
                docId: `${cluster.category}/${cluster.slug}`,
                category: cluster.category,
                slug: cluster.slug,
                kind: 'created' as const,
                summary: obs.frontmatter.summary ?? '',
              });
            } catch (err) {
              log.warn('memory_strata_doc_written_publish_failed', {
                err: err instanceof Error ? err : new Error(String(err)),
                docId: `${cluster.category}/${cluster.slug}`,
                kind: 'created',
              });
            }
          }
        } else {
          await appendFact({
            workspaceRoot: input.workspaceRoot,
            category: cluster.category,
            slug: cluster.slug,
            newFact: formatFactLine(
              obs.frontmatter.summary ?? '',
              obs.frontmatter.event_time ?? obs.frontmatter.recorded_at,
            ),
            observationId: obs.frontmatter.id,
            // TASK-187: dedup this observation's conversation into the doc's
            // distinct set — a new conversation grows recurrence; a repeat
            // from a seen conversation does not.
            conversationId: obs.frontmatter.conversation_id,
            confidence: obs.frontmatter.confidence ?? 0,
            now: input.now,
          });
          if (input.bus !== undefined && input.ctx !== undefined) {
            try {
              await input.bus.fire('memory:doc:written', input.ctx, {
                docId: `${cluster.category}/${cluster.slug}`,
                category: cluster.category,
                slug: cluster.slug,
                kind: 'updated' as const,
                summary: obs.frontmatter.summary ?? '',
              });
            } catch (err) {
              log.warn('memory_strata_doc_written_publish_failed', {
                err: err instanceof Error ? err : new Error(String(err)),
                docId: `${cluster.category}/${cluster.slug}`,
                kind: 'updated',
              });
            }
          }
        }

        factsInDoc.push(obs.frontmatter.summary ?? '');
        await deleteInboxFile(input.workspaceRoot, obs.path);
        promoted += 1;
        // TASK-200 dirty gate: a promotion into an enumerable-category doc can
        // create/grow a class → run the rollup pass this consolidation.
        if (ENUMERABLE_CATEGORIES.has(cluster.category)) enumerableWrite = true;
      }

      // D4: emit the near-dup merge line iff the redirect actually led to a
      // real write/merge into the existing doc this pass (a promote or a
      // dedup-merge advanced a counter). `newSlug` reports the pre-redirect
      // slug so the metric shows what folded into what.
      if (nearDup !== null && (promoted > promotedBefore || dupesMerged > dupesMergedBefore)) {
        log.warn('memory_strata_near_dup_slug_merged', {
          category: cluster.category,
          newSlug: originalSlug,
          mergedInto: nearDup,
        });
      }
    }

    // TASK-200 rollup pass — ordered AFTER near-dup merge/write (so a class
    // counts merged docs once) and BEFORE the final regenerateMap (so new/GC'd
    // rollups get map lines in the SAME pass): decay → cluster → decide/dedup/
    // write → rollup pass → recent/map regen. Runs only on a dirty pass (a fact
    // was promoted/merged into an enumerable-category doc); an idle pass or a
    // preference/decision-only pass can't change any class, so it's skipped.
    if (enumerableWrite) {
      // Best-effort, like regenerateMap below: a rollup is an ACCELERATOR, never
      // the sole path (design), so a throw in the rollup code must NOT abort the
      // pass and skip the always-injected recent.md/map.md regen. Isolate it.
      try {
        const rollup = await runRollupPass({
          workspaceRoot: input.workspaceRoot,
          now: input.now,
          log,
          bus: input.bus,
          ctx: input.ctx,
          config: input.rollupConfig,
          stageB: input.rollupStageB,
        });
        rollupsWritten = rollup.written;
        rollupsSkipped = rollup.skipped;
        rollupsDeleted = rollup.deletedDocIds;
      } catch (rollupErr) {
        log.warn('memory_strata_rollup_pass_failed', {
          err: rollupErr instanceof Error ? rollupErr : new Error(String(rollupErr)),
        });
      }
    }

    // I13: regenerate the cached views last, after all promotions are
    // committed. recent.md first, then map.md (TASK-190) — both are derived
    // from the now-final docs/ + inbox/ state. The map densifies each doc's
    // one-liner via the host LLM when a densifier is wired (incremental, cached
    // per-doc); without one it falls back to raw summaries. Map generation is
    // best-effort: a failure regenerating the map must NOT roll back committed
    // promotions or fail the whole pass, so it's caught + logged separately.
    await regenerateRecent({ workspaceRoot: input.workspaceRoot, now: input.now });
    try {
      await regenerateMap({
        workspaceRoot: input.workspaceRoot,
        now: input.now,
        densify: input.densifyMap,
        logger: log,
      });
    } catch (mapErr) {
      log.warn('memory_strata_map_regenerate_failed', {
        err: mapErr instanceof Error ? mapErr : new Error(String(mapErr)),
      });
    }
  } catch (err) {
    // C2 fix: emit the audit event with partial counters so operators can
    // see how far the pass progressed before the failure.
    log.warn('memory_strata_consolidator_failed', {
      err: err instanceof Error ? err : new Error(String(err)),
      promoted,
      dupesMerged,
      quarantined,
      leftInInbox,
      decayed,
    });
    throw err;
  }

  log.info('memory_strata_consolidation_complete', {
    promoted, dupesMerged, quarantined, leftInInbox, decayed,
    rollupsWritten, rollupsSkipped, rollupsDeleted: rollupsDeleted.length,
  });
  return {
    promoted, dupesMerged, quarantined, leftInInbox, decayed,
    rollupsWritten, rollupsSkipped, rollupsDeleted,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Delete inbox observations whose `created` timestamp is older than
 * DECAY_DAYS (I14). Runs before clustering so decayed files are never
 * considered for promotion.
 */
async function decayInbox(
  workspaceRoot: string,
  now: Date,
  log: ConsolidationLogger,
): Promise<{ decayed: number }> {
  const inbox = await listInbox(workspaceRoot);
  const cutoffMs = now.getTime() - DECAY_DAYS * 86_400_000;
  let decayed = 0;
  for (const f of inbox) {
    const ts = new Date(f.frontmatter.created).getTime();
    if (Number.isNaN(ts)) {
      // C3 fix: warn so operators can identify observations with corrupt
      // frontmatter rather than silently skipping them forever.
      log.warn('memory_strata_inbox_decay_invalid_created', {
        id: f.frontmatter.id,
        created: f.frontmatter.created,
        inboxPath: f.path,
      });
      continue;
    }
    if (ts > cutoffMs) continue;
    await deleteInboxFile(workspaceRoot, f.path);
    log.info('memory_strata_inbox_decayed', {
      id: f.frontmatter.id,
      ageDays: Math.round((now.getTime() - ts) / 86_400_000),
    });
    decayed += 1;
  }
  return { decayed };
}

/**
 * Move an inbox file to the quarantine directory (I11).
 *
 * The file is renamed (not copied then deleted) to make the move atomic on
 * POSIX filesystems. A crash between rename and log.warn is tolerable —
 * the file is already safe in quarantine.
 */
async function quarantineFile(workspaceRoot: string, inboxPath: string): Promise<void> {
  const name = inboxPath.split('/').pop()!;
  const dest = `${QUARANTINE_DIR}/${name}`;
  const absSrc = join(workspaceRoot, inboxPath);
  const absDest = join(workspaceRoot, dest);
  await mkdir(dirname(absDest), { recursive: true });
  await rename(absSrc, absDest);
}

/**
 * Extract the bullet-list items under the `## Facts` heading from a doc body.
 *
 * Returns an empty array when the section is absent (e.g. a hand-edited doc
 * that lost the heading). The consolidator uses these to seed the dedup check
 * for subsequent observations in the same cluster pass.
 */
function extractFactsFromBody(body: string): string[] {
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => l.trim() === '## Facts');
  if (idx === -1) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.startsWith('## ')) break;
    if (l.startsWith('- ')) out.push(l.slice(2).trim());
  }
  return out;
}

function noopLogger(): ConsolidationLogger {
  return { info: () => {}, warn: () => {} };
}

/**
 * List the doc slugs already on disk in a category directory (D4 near-dup
 * guard). A missing category directory (no docs promoted there yet) is not
 * an error — it just means there are no near-dup candidates.
 */
async function listCategorySlugs(workspaceRoot: string, category: DocCategory): Promise<string[]> {
  const dirAbs = join(workspaceRoot, categoryDir(category));
  try {
    const names = await readdir(dirAbs);
    return names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -'.md'.length));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
