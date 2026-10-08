// TASK-762 — slot names the connector editors mint for the credentials they
// store at `account:<connectorId>:<slot>`.
//
// The destination-credential route (@ax/credentials-admin-routes) only accepts
// a slot in the connector SLOT grammar — SCREAMING_SNAKE, the same `SLOT_RE` as
// @ax/connectors and @ax/skills-parser. Slots are a credential boundary, so the
// route stays strict and the editors emit names that fit it. The editors used to
// write `header-<uuid>` and `oauth-client-secret`, which the route refused with
// `400 invalid account slot`, so nobody could save a request header or an OAuth
// client secret from the UI.
//
// There is deliberately no local copy of that grammar here: a hand-kept mirror
// is how the two drifted. `__tests__/connector-credential-slots.contract.test.ts`
// (TASK-767) POSTs what these functions mint through the REAL route instead, so
// a change on either side goes red.

/** Where a connector's own OAuth client secret is stored. */
export const OAUTH_CLIENT_SECRET_SLOT = 'OAUTH_CLIENT_SECRET';

/** A fresh, collision-free slot for one request header: `HEADER_` + 32
 * uppercase hex chars (39 chars, under the grammar's 64). */
export function newHeaderSlot(): string {
  return `HEADER_${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`;
}

/**
 * A connector's custom OAuth client secret is stored at the workspace (global
 * scope), so everyone who signs in can use it. The host serves a global secret
 * only to signers of a connector that is shared AND admin-owned, so a PRIVATE
 * connector can't carry one: nobody, its owner included, could read it.
 *
 * Slice 5 — nothing is stored per person, so there is no "keep it with its
 * author" fallback any more. The editors refuse the save with this message
 * and write nothing.
 */
export const CLIENT_SECRET_NEEDS_SHARED = 'Make it Shared to use a client secret.';
