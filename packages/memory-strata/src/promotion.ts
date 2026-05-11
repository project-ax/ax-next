// Promotion gate (Phase 2A, I11 — defense-in-depth).
//
// WHY this exists: Phase 1's sensitive-gate (sensitive-gate.ts, I7) runs
// at write-time — before an observation is persisted to inbox/. Phase 2A's
// consolidation pass runs later, after those files already exist on disk.
// Between those two moments a regression in Phase 1's gate could, in theory,
// allow a credential to land in inbox/. If we promoted that observation to
// docs/ without a second look, the credential would be cached there and
// re-loaded into the agent's context on the very next turn — an automatic
// exfiltration channel for any subsequent prompt-injection.
//
// Running the sensitive-gate a second time here (I11) closes that window.
// Even if Phase 1's gate is entirely bypassed — e.g., a direct write to
// inbox/ by a test fixture or a future code path that forgets to gate —
// no credential can graduate to docs/ without passing this check.
//
// Confidence check comes first (cheap exit). Sensitive check comes second
// (covers the I11 regression scenario).

import { filterSensitive, type RejectionKind } from './sensitive-gate.js';
import type { InboxFile } from './inbox-store.js';

/** Minimum observer confidence for an inbox observation to be promoted. */
export const CONFIDENCE_THRESHOLD = 0.7;

/**
 * The outcome of `decidePromotion`. Callers should switch on `promote`:
 *
 * - `{ promote: true }` — safe to write to docs/.
 * - `{ promote: false, reason: 'low-confidence' }` — observation doesn't
 *   meet the quality bar; decay normally.
 * - `{ promote: false, reason: 'sensitive', kinds }` — sensitive-gate fired
 *   at promotion-time (I11 regression scenario); the inbox file should be
 *   deleted immediately, not decayed.
 */
export type PromotionDecision =
  | { promote: true }
  | { promote: false; reason: 'low-confidence' }
  | {
      promote: false;
      reason: 'sensitive';
      /** Distinct rejection kinds (deduplicated even when the same pattern fires on summary AND body). */
      kinds: RejectionKind[];
    };

/**
 * Decide whether a parsed inbox observation should be promoted to docs/.
 *
 * I11: two-gate strategy —
 *  1. Confidence gate — reject low-quality observations before they graduate.
 *  2. Sensitive re-run — defense-in-depth against Phase 1 gate regressions.
 *
 * @param file — A parsed inbox observation from `listInbox`.
 * @returns A `PromotionDecision` the consolidator uses to route the file.
 */
export function decidePromotion(file: InboxFile): PromotionDecision {
  if ((file.frontmatter.confidence ?? 0) < CONFIDENCE_THRESHOLD) {
    return { promote: false, reason: 'low-confidence' };
  }

  // Defense-in-depth: sensitive-gate runs at write-time (Phase 1, I7) AND
  // at promotion-time (Phase 2A, I11). If a regression in the Phase 1
  // gate ever lets a credential into inbox/, this catches it before the
  // fact graduates to docs/, where it would be cached and re-loaded into
  // the agent's context next turn.
  const haystack = `${file.frontmatter.summary ?? ''}\n${file.body}`;
  const gate = filterSensitive(haystack);
  if (!gate.kept) {
    return {
      promote: false,
      reason: 'sensitive',
      kinds: [...new Set(gate.rejections.map((r) => r.kind))],
    };
  }

  return { promote: true };
}
