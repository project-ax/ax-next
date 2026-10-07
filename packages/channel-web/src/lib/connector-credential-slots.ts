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
 * Where the editors store a connector's custom OAuth client secret.
 *
 * `'global'` is readable workspace-wide, which is what lets people other than
 * the author sign in. It is only safe to read that widely when the connector
 * itself is workspace-wide, so the host serves a global secret only to signers
 * of a connector that is shared AND admin-owned. That decides the rule here:
 *
 * Only admins write connectors (slice 2a), so the author is always an admin:
 *
 *   - a workspace-key connector keeps its secret at the workspace, as ever;
 *   - a shared connector does too, so everyone can sign in with the OAuth app
 *     the admin registered;
 *   - a PRIVATE connector stays at the author's own scope. A global secret
 *     would be unreadable even by its owner (it is not shared), so the only
 *     person who could sign in would be locked out.
 */
export function clientSecretScope(args: {
  keyMode: 'personal' | 'workspace';
  visibility: 'private' | 'shared';
}): 'global' | 'user' {
  return args.keyMode === 'workspace' || args.visibility === 'shared'
    ? 'global'
    : 'user';
}
