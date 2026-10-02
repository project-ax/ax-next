import type { AgentContext, HookBus } from '@ax/core';
import { deriveCredentialPlan } from './credential-plan.js';
import type { ConnectorStore } from './store.js';
import type { AuthorizeGlobalInput, AuthorizeGlobalOutput } from './types.js';

// ---------------------------------------------------------------------------
// TASK-697 — who may read a COMPANY-WIDE (global-scope) connector credential.
//
// THE BUG THIS CLOSES. A connector's credential ref is `account:<connectorId>`
// (or `account:<connectorId>:<SLOT>` for a connector with two or more slots) and
// the connector id is chosen by whoever authors the connector. @ax/credentials'
// `credentials:get` walks user -> agent -> global for every ref, so a user who
// authored a connector called `zendesk` read the company's `account:zendesk` key
// at global scope, whatever their connector's keyMode said.
//
// THE RULE. @ax/credentials now asks THIS hook before it takes the global step
// for an `account:` ref. We allow it iff, for the REQUESTING user:
//
//   1. the ref parses as `account:<id>` / `account:<id>:<SLOT>` with a valid id,
//   2. that user can read a LIVE owned or unambiguous shared connector with that id,
//   3. the connector's derived credential plan contains EXACTLY this ref at
//      scope `global` (i.e. `keyMode: 'workspace'`) — `deriveCredentialPlan` is
//      the single function that decides both a slot's ref and its scope, so the
//      write (connect flow), the probe, the delete-purge and this read cannot
//      disagree, and
//   4. that owner is an ADMIN. `keyMode: 'workspace'` means "an admin supplies
//      ONE shared key"; the role is checked at READ time, not only when the row
//      was written, so a workspace-keyed row that a non-admin managed to author
//      (the un-gated admin route, the model-authored approve path, legacy data)
//      still gets nothing.
//
// FAIL CLOSED. Anything unexpected is a deny: unparseable ref, no connector,
// personal keyMode, no `auth:get-user` provider, no such user, a throwing lookup.
// The caller (@ax/credentials) treats a deny as "no credential here" and keeps
// walking, so the user sees the same `credential-not-found` a missing key gives.
// Nothing here ever reads, returns or logs a secret value.
//
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/connectors';
const ACCOUNT_PREFIX = 'account:';
const MAX_ID_LEN = 128;
// Same grammar as store.ts ID_RE. Inlined (not imported) so this stays a pure
// parse: a malformed id is a deny, never a thrown validation error.
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_FIELD_LEN = 256;

/** `account:<id>` -> `<id>`; `account:<id>:<SLOT>` -> `<id>`; anything else -> null. */
function connectorIdOfAccountRef(ref: string): string | null {
  if (!ref.startsWith(ACCOUNT_PREFIX)) return null;
  const parts = ref.slice(ACCOUNT_PREFIX.length).split(':');
  if (parts.length > 2) return null;
  const id = parts[0];
  if (id === undefined || id.length === 0 || id.length > MAX_ID_LEN) return null;
  return CONNECTOR_ID_RE.test(id) ? id : null;
}

interface AuthUserLike {
  isAdmin?: unknown;
}

export async function authorizeGlobalAccountRead(
  store: ConnectorStore,
  bus: HookBus,
  ctx: AgentContext,
  input: AuthorizeGlobalInput,
): Promise<AuthorizeGlobalOutput> {
  const deny = (reason: string): AuthorizeGlobalOutput => {
    // Ids only — never a value. `ref` and `userId` are identifiers, not secrets.
    ctx.logger.info('connectors_global_credential_denied', {
      reason,
      ref: typeof input.ref === 'string' ? input.ref.slice(0, MAX_FIELD_LEN) : '',
    });
    return { allowed: false };
  };

  const { userId, ref } = input;
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > MAX_FIELD_LEN) {
    return deny('bad-user');
  }
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_FIELD_LEN) {
    return deny('bad-ref');
  }
  const connectorId = connectorIdOfAccountRef(ref);
  if (connectorId === null) return deny('not-a-connector-ref');

  try {
    const available = await store.getAvailableById(userId, connectorId);
    if (available === null) return deny('no-such-connector');
    const { connector, ownerUserId } = available;

    const grantsGlobalRef = deriveCredentialPlan(connector).some(
      (entry) => entry.scope === 'global' && entry.ref === ref,
    );
    if (!grantsGlobalRef) return deny('connector-not-workspace-keyed');

    // Optional call: without an auth provider we cannot prove the owner is an
    // admin, so the company key stays closed.
    if (!bus.hasService('auth:get-user')) return deny('no-auth-provider');
    const owner = await bus.call<{ userId: string }, AuthUserLike | null>(
      'auth:get-user',
      ctx,
      { userId: ownerUserId },
    );
    if (owner === null || owner === undefined || owner.isAdmin !== true) {
      return deny('owner-not-admin');
    }
    return { allowed: true };
  } catch (err) {
    ctx.logger.warn('connectors_global_credential_check_failed', {
      plugin: PLUGIN_NAME,
      ref,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: false };
  }
}
