import type { AgentContext, HookBus } from '@ax/core';

/**
 * Cold-start admit-queue trigger (JIT design §13 — the self-healing loop).
 *
 * When the broker's search/request tools find no catalog hit, the unmet need is
 * filed to the admin admit queue via the EXISTING `catalog:submit` hook
 * (TASK-41, owned by @ax/skills). This module is the broker's local trigger —
 * it never imports across the plugin boundary (I2); the bus is the only seam.
 *
 * Untrusted-input posture (I5): the model's free-text `intent` rides only as the
 * request *description* (data an admin triages — NEVER parsed as a manifest), and
 * the dedup `skillId` is a locally-sanitized slug re-validated below. A cold-start
 * request is non-promotable (TASK-41's admit path rejects `cold-start`), so this
 * filed text can't forge an admitted catalog skill. `requestedByUserId` is taken
 * from the authenticated `ctx.userId`, never from model input.
 */

/** Max length of the free-text need stored on a cold-start request. */
export const CAPABILITY_NEED_MAX = 280;

/** Max length of a derived dedup slug (kept well under the catalog id grammar). */
const SLUG_MAX = 64;

// The catalog skill-id grammar the slug must satisfy so the store can key on it
// as a dedup id (mirrors @ax/skills' id shape; re-checked here, not imported).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A guaranteed-valid fallback slug when the intent yields nothing usable. */
const FALLBACK_SLUG = 'capability';

/**
 * Derive a dedup slug from a free-text intent: lowercase, non-alnum → `-`,
 * collapse repeats, trim edge dashes, cap length, re-trim. Falls back to
 * `capability` if the result is empty or fails the id grammar. The slug is a
 * dedup KEY (one pending request per slug), never executed code.
 */
export function deriveColdStartSlug(intent: string): string {
  const slug = intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    // A mid-slug length cut can leave a trailing dash — strip it again.
    .replace(/-+$/g, '');
  return SLUG_RE.test(slug) ? slug : FALLBACK_SLUG;
}

/** Trim + cap the free-text need stored as the request description. */
export function clampNeed(text: string): string {
  return text.trim().slice(0, CAPABILITY_NEED_MAX);
}

interface ColdStartSubmitInput {
  kind: 'cold-start';
  skillId: string;
  requestedByUserId: string;
  description: string;
}

/**
 * File a cold-start admit-queue request for an unmet capability need.
 *
 * `hasService`-guarded + best-effort: on a catalog-less/queue-less preset (no
 * `catalog:submit`) or a transient failure this is a silent no-op — the broker's
 * core search/request contract (the not-found / empty result) is never affected.
 * The store dedups on `skillId`, so repeated misses for the same slug collapse to
 * one pending request.
 */
export async function fireColdStartSubmit(
  bus: HookBus,
  ctx: AgentContext,
  need: { skillId: string; description: string },
): Promise<void> {
  if (!bus.hasService('catalog:submit')) return;
  try {
    await bus.call<ColdStartSubmitInput, unknown>('catalog:submit', ctx, {
      kind: 'cold-start',
      skillId: need.skillId,
      requestedByUserId: ctx.userId,
      description: need.description,
    });
  } catch {
    // A failed submit must never fail the host tool. The miss is still returned
    // to the model as not-found/empty; the need just wasn't queued this time.
  }
}
