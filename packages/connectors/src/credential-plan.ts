import type { Capabilities, CapabilitySlot, Connector, KeyMode } from './types.js';

// ---------------------------------------------------------------------------
// TASK-96 — reach-by-attachment + connector keyMode connect flow (design Phase 3).
//
// THE DERIVATION. A connector declares `keyMode: 'personal' | 'workspace'`. This
// module turns that into the credential PLAN the connect flow (and the future
// credential-proxy router — design Phase 5: "resolving slots through the
// connector instead of the skill") routes on. Reach is derived PURELY from where
// the key attaches — there is NO public/private flag on a credential:
//
//   keyMode 'personal'  → credential scope 'agent'  — each agent adds its own
//                         key (or sign-in) when the connector is added to it
//                         (`ownerId` = the agent id). Nothing is ever stored per
//                         PERSON: an agent never acts as the person chatting
//                         with it (agent-owned sign-ins, slice 5).
//   keyMode 'workspace' → credential scope 'global' — an admin supplies ONE key;
//                         every allowed agent spends it as a shared service
//                         identity (the company key).
//
// Both modes use the SAME `account:<tag>[:<SLOT>]` ref shape — only the SCOPE
// differs. The tag is ALWAYS the connector id (`serviceTagForSlot`): each
// connector owns its own key(s), and two connectors naming the same upstream
// service each store their own copy. (The original "share by service" lean —
// one key per service, shared across connectors and skills — is gone; a legacy
// slot `account` tag is ignored.)
//
// READ AUTHORIZATION (TASK-697). This plan says which scope a slot's key is
// WRITTEN to; it is also what decides who may READ a `global` one. The ref is
// `account:<connector id>` and the id is chosen by whoever authors the connector,
// so the vault cannot treat "same ref" as "same connector": @ax/credentials asks
// `credentials:authorize-global:account` (credential-authz.ts, which reads THIS
// plan) before an `account:` ref may fall through to global scope. A personal
// connector therefore never reads a company key, whatever its id.
//
// NOT IN THE PLAN: a connector's OAuth CLIENT secret (`account:<id>:OAUTH_CLIENT_SECRET`,
// TASK-797). This plan is also the connect-flow prompt list, the attach credential
// gate and the describe-tools slot resolver; the client secret must reach none of
// them. Its global read has its own rule in credential-authz.ts.
//
// I2 — no @ax/credentials runtime import. The credential-scope vocabulary
// (`global | user | agent`) is the stable inter-plugin contract, re-declared
// LOCALLY here (same posture as the local zod re-declaration of Capabilities in
// types.ts). The plan only emits the two scopes the keyMode derivation produces
// (`agent` | `global`); `user` stays in the union for completeness of the
// contract (other ref kinds still live per person) but a connector key never
// lands there.
// ---------------------------------------------------------------------------

/** The neutral credential-scope contract (mirrors @ax/credentials' scope).
 *  Re-declared locally to avoid a cross-plugin runtime import (I2). */
export type CredentialScope = 'global' | 'user' | 'agent';

/** One derived credential binding: which scope + ref a connector slot spends.
 *  Storage- and mechanism-agnostic (slot / scope / ref are neutral). */
export interface CredentialPlanEntry {
  /** The capability slot name this binding satisfies. */
  slot: string;
  /** The credential scope the key binds to — reach derives from this alone.
   *  `agent` means "on whichever agent the connector is added to" (`ownerId` =
   *  that agent's id); `global` is the one shared company key. */
  scope: Extract<CredentialScope, 'agent' | 'global'>;
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
 * The service tag for a slot — the `<service>` in `account:<service>`. Each
 * connector owns its own key(s): the tag is ALWAYS the connector id, so two
 * connectors that name the same upstream service each store their own copy (no
 * share-by-service). A legacy `account` tag on stored data is IGNORED (it is also
 * stripped on read by the connector store's capabilities re-validation), so this
 * is the single rule the connect-flow WRITE and the host-resolver READ agree on.
 *
 * `_slot` is retained for signature stability (callers pass the slot positionally)
 * but is no longer consulted.
 */
export function serviceTagForSlot(_slot: CapabilitySlot, connectorId: string): string {
  return connectorId;
}

/**
 * Build the per-agent / company vault ref for a service. Re-derived locally (no
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
function scopeForKeyMode(keyMode: KeyMode): Extract<CredentialScope, 'agent' | 'global'> {
  return keyMode === 'workspace' ? 'global' : 'agent';
}

/**
 * Derive one credential-plan entry per declared credential slot. The connect flow
 * uses this to know WHOSE key to prompt for / spend: a `personal` connector
 * resolves every slot to the agent's own key (`scope:'agent'`), a `workspace`
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
export function deriveCredentialPlan(
  connector: Pick<Connector, 'id' | 'keyMode'> & { capabilities: Pick<Capabilities, 'credentials'> },
): CredentialPlanEntry[] {
  const scope = scopeForKeyMode(connector.keyMode);
  const isMulti = connector.capabilities.credentials.filter((slot) => slot.kind !== 'api-key' || !slot.headerName).length >= 2;
  return connector.capabilities.credentials.map((slot) => {
    const service = serviceTagForSlot(slot, connector.id);
    const perSlot = isMulti || (slot.kind === 'api-key' && Boolean(slot.headerName));
    return {
      slot: slot.slot,
      scope,
      ref: accountRef(service, perSlot ? slot.slot : undefined),
      service,
      ...(perSlot ? { slotTag: slot.slot } : {}),
    };
  });
}
