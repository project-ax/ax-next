import type { CapabilitySlot, Connector, KeyMode } from './types.js';

// ---------------------------------------------------------------------------
// TASK-96 — reach-by-attachment + connector keyMode connect flow (design Phase 3).
//
// THE DERIVATION. A connector declares `keyMode: 'personal' | 'workspace'`. This
// module turns that into the credential PLAN the connect flow (and the future
// credential-proxy router — design Phase 5: "resolving slots through the
// connector instead of the skill") routes on. Reach is derived PURELY from where
// the key attaches — there is NO public/private visibility flag on a credential:
//
//   keyMode 'personal'  → credential scope 'user'   — each user supplies their
//                         own key the first time they use the connector (the
//                         existing JIT `account:<service>` per-user vault flow);
//                         everyone acts as themselves.
//   keyMode 'workspace' → credential scope 'global' — an admin supplies ONE key;
//                         every allowed agent spends it as a shared service
//                         identity (the company key).
//
// Both modes use the SAME `account:<service>` ref shape — only the SCOPE differs.
// (Design open-Q #1 lean "share by service": the `account:<service>` vault key is
// the natural credential identity, reused across connectors/skills that name the
// same service. The chat-orchestrator's `applyCapabilityGrant` already binds
// `account:<service>` for `account`-tagged skill slots; connectors reuse that
// exact ref so a personal connector and a skill to the same service share one key.)
//
// I2 — no @ax/credentials runtime import. The credential-scope vocabulary
// (`global | user | agent`) is the stable inter-plugin contract, re-declared
// LOCALLY here (same posture as the local zod re-declaration of Capabilities in
// types.ts). The plan only emits the two scopes the keyMode derivation produces
// (`user` | `global`); `agent` exists in the union for completeness of the
// contract (a key bound to a shared agent is the design's other reach) but is not
// produced by this derivation.
// ---------------------------------------------------------------------------

/** The neutral credential-scope contract (mirrors @ax/credentials' scope).
 *  Re-declared locally to avoid a cross-plugin runtime import (I2). */
export type CredentialScope = 'global' | 'user' | 'agent';

/** One derived credential binding: which scope + ref a connector slot spends.
 *  Storage- and mechanism-agnostic (slot / scope / ref are neutral). */
export interface CredentialPlanEntry {
  /** The capability slot name this binding satisfies. */
  slot: string;
  /** The credential scope the key binds to — reach derives from this alone. */
  scope: Extract<CredentialScope, 'user' | 'global'>;
  /**
   * The deterministic vault ref the proxy resolves. `account:<service>` for a
   * single-slot connector (back-compat); `account:<service>:<slot>` for a
   * multi-slot connector (TASK-124 — per-slot refs, no collision).
   */
  ref: string;
  /**
   * The `<service>` tag inside the ref (the slot's `account` or the connector
   * id). Carried structurally (TASK-124) so the connect-flow UI can rebuild the
   * `{kind:'account', service, slot?}` destination WITHOUT string-parsing the
   * `:`-bearing ref (a per-slot ref would otherwise slice into an invalid
   * account service). Always present.
   */
  service: string;
  /**
   * The `<slot>` tag inside the ref, present IFF the per-slot ref form is used
   * (multi-slot connector). The UI passes it as the optional `slot` on the
   * account destination; absent ⟹ the collapsed `account:<service>` ref.
   */
  slotTag?: string;
}

/**
 * The service tag for a slot — the `<service>` in `account:<service>`. Prefer the
 * slot's declared `account` (share-by-service); fall back to the connector id when
 * a slot omits it, so a slotless-account connector still gets a stable per-service
 * vault key.
 */
export function serviceTagForSlot(slot: CapabilitySlot, connectorId: string): string {
  return slot.account !== undefined && slot.account.length > 0 ? slot.account : connectorId;
}

/**
 * Build the per-user / company vault ref for a service. Re-derived locally (no
 * @ax/credentials import) — identical to `refForDestination({kind:'account', …})`
 * and to the ref `applyCapabilityGrant` binds for an `account`-tagged slot, so the
 * key a connector resolves and the key a skill stored always address the same row.
 *
 * TASK-124 — adaptive per-slot ref. Pass `slot` (the connector's declared
 * SCREAMING_SNAKE capability slot) for a multi-slot connector → the distinct
 * `account:<service>:<slot>` row; omit it for a single-slot connector → the
 * collapsed `account:<service>` ref (back-compat by construction).
 */
export function accountRef(service: string, slot?: string): string {
  return slot !== undefined ? `account:${service}:${slot}` : `account:${service}`;
}

/** keyMode → the credential scope the key attaches to (reach-by-attachment). */
function scopeForKeyMode(keyMode: KeyMode): Extract<CredentialScope, 'user' | 'global'> {
  return keyMode === 'workspace' ? 'global' : 'user';
}

/**
 * Derive one credential-plan entry per declared credential slot. The connect flow
 * uses this to know WHOSE key to prompt for / spend: a `personal` connector
 * resolves every slot to the per-user vault (`scope:'user'`), a `workspace`
 * connector to the single company key (`scope:'global'`). A connector with no
 * credential slots yields an empty plan (nothing to prompt — e.g. an MCP server
 * that needs no key).
 *
 * TASK-124 — per-slot credential refs (adaptive, back-compat by construction).
 * The collapse-vs-expand rule keys on the connector's slot COUNT: a connector
 * with exactly ONE slot keeps the collapsed `account:<service>` ref (existing
 * keys resolve unchanged); a connector with TWO OR MORE slots derives a distinct
 * `account:<service>:<slot>` ref per slot, fixing the prior collision where two
 * slots that fall back to the same service tag overwrote each other on one row.
 */
export function deriveCredentialPlan(connector: Connector): CredentialPlanEntry[] {
  const scope = scopeForKeyMode(connector.keyMode);
  const isMulti = connector.capabilities.credentials.length >= 2;
  return connector.capabilities.credentials.map((slot) => {
    const service = serviceTagForSlot(slot, connector.id);
    return {
      slot: slot.slot,
      scope,
      ref: accountRef(service, isMulti ? slot.slot : undefined),
      service,
      ...(isMulti ? { slotTag: slot.slot } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Consent — the "act as you" gate (design "Consent caveat", invariant #5).
//
// The credential-proxy stops key THEFT, not authorized MISUSE: anyone who can
// drive an agent that spends a shared key can make it act as that identity on the
// service. Sharing a key for USE is therefore NOT as harmless as sharing a skill,
// and the design surfaces one explicit consent moment BEFORE the key becomes
// spendable by a shared/team agent — not fine print.
// ---------------------------------------------------------------------------

/**
 * Whether connecting this connector must surface the shared-key consent moment
 * before the key becomes spendable. True iff the resolved key is spendable by an
 * identity the keyholder doesn't solely control:
 *   - `keyMode === 'workspace'` — one key, every allowed agent spends it, OR
 *   - `visibility === 'shared'` — bound to a shared / team agent.
 * `personal` + `private` → false (you only ever act as yourself; no consent needed).
 */
export function requiresSharedKeyConsent(connector: Connector): boolean {
  return connector.keyMode === 'workspace' || connector.visibility === 'shared';
}

/**
 * The shared-key consent copy (design "Consent caveat"). A `%SERVICE%` placeholder
 * the connect surface fills via {@link sharedKeyConsentMessage}. Exported so the
 * future connect-flow UI renders the SAME wording the design specifies and a test
 * pins it — the consent text is a security-relevant contract, not throwaway UI copy.
 */
export const SHARED_KEY_CONSENT_COPY =
  "Sharing this key lets their assistant act as you on %SERVICE%. They can't copy the key — but they can use it.";

/** Fill the consent copy with a concrete service name. */
export function sharedKeyConsentMessage(service: string): string {
  return SHARED_KEY_CONSENT_COPY.replace('%SERVICE%', service);
}
