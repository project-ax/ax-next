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
// Local mirror of that grammar (invariant 2: no cross-plugin import). Keep it in
// step with `destination-routes.ts`; the route's own tests pin the shapes below.
export const CONNECTOR_SLOT_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Where a connector's own OAuth client secret is stored. */
export const OAUTH_CLIENT_SECRET_SLOT = 'OAUTH_CLIENT_SECRET';

/** A fresh, collision-free slot for one request header: `HEADER_` + 32
 * uppercase hex chars (39 chars, under the grammar's 64). */
export function newHeaderSlot(): string {
  return `HEADER_${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`;
}
