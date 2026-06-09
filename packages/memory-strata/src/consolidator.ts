// Consolidator — heart of Phase 2A. Walks the inbox, groups by subject,
// deduplicates against existing doc facts, promotes high-confidence
// observations to `docs/<category>/<slug>.md`, quarantines sensitive
// observations (I11 extension), decays aged-out observations (I14), and
// regenerates `system/recent.md` (I13).
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

import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentContext, HookBus } from '@ax/core';
import { clusterBySubject } from './cluster.js';
import { isDupe } from './dedup.js';
import {
  appendFact, mergeConversationIntoDoc, readDoc, writeNewDoc,
} from './doc-store.js';
import { deleteInboxFile, listInbox } from './inbox-store.js';
import { decidePromotion } from './promotion.js';
import { regenerateRecent } from './recent.js';
import { MEMORY_ROOT } from './paths.js';

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

  try {
    ({ decayed } = await decayInbox(input.workspaceRoot, input.now, log));

    const inbox = await listInbox(input.workspaceRoot);
    const clusters = clusterBySubject(inbox);

    for (const cluster of clusters) {
      const existing = await readDoc({
        workspaceRoot: input.workspaceRoot,
        category: cluster.category,
        slug: cluster.slug,
      });
      const existingFacts = existing ? extractFactsFromBody(existing.body) : [];

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
            facts: [obs.frontmatter.summary ?? ''],
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
            newFact: obs.frontmatter.summary ?? '',
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
      }
    }

    // I13: regenerate the cached view last, after all promotions are committed.
    await regenerateRecent({ workspaceRoot: input.workspaceRoot, now: input.now });
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
  });
  return { promoted, dupesMerged, quarantined, leftInInbox, decayed };
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
