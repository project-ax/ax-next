import type { AgentContext, HookBus } from '@ax/core';
import { deriveCredentialPlan } from './credential-plan.js';
import { namesOAuthClientSecretRef, oauthClientSecretRefFor } from './oauth-client-secret-ref.js';
import type { ConnectorStore } from './store.js';
import type {
  AuthorizeAgentInput,
  AuthorizeAgentOutput,
  AuthorizeGlobalInput,
  AuthorizeGlobalOutput,
} from './types.js';

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
// ONE EXCEPTION: `account:<id>:OAUTH_CLIENT_SECRET` (a connector's OAuth client
// secret) never takes this path; it has its own rule below (TASK-797).
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

  // TASK-797 — a client-secret ref is decided by its own rule, and ONLY by it.
  if (ref === oauthClientSecretRefFor(connectorId)) {
    return authorizeGlobalClientSecretRead(store, bus, ctx, userId, connectorId, ref, deny);
  }

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

// ---------------------------------------------------------------------------
// TASK-797 — who may read a connector's OAuth CLIENT SECRET at global scope.
//
// THE GAP THIS CLOSES. A custom-client OAuth connector pins a client id and a
// client secret. The editor stored the secret at the AUTHOR's user scope, and
// @ax/mcp-oauth's `begin` reads it as the person signing in, so only the
// author could ever sign in (`400 oauth_client_secret_unavailable` for
// everyone else). An admin's shared connector now stores it at global scope
// instead, and this rule decides who may read it there.
//
// THE RULE. A global read of `account:<id>:OAUTH_CLIENT_SECRET` is allowed iff
// ALL of these hold for the REQUESTING user:
//
//   1. the connector this user resolves for `<id>` is the ONE live SHARED
//      definition with that id (`getSoleSharedById`, TASK-711's predicate) —
//      not a private one (theirs or anyone's), and not one of two sharers,
//   2. one of its OAuth slots names EXACTLY this ref as `clientSecretRef`,
//   3. the ref is NOT also a credential-plan ref of that connector. The plan is
//      what the credential proxy injects into the sandbox; a connector that
//      named a slot `OAUTH_CLIENT_SECRET` would otherwise hand the secret to a
//      runner. The secret is used host-side only, against the token endpoint.
//   4. the connector's owner is an ADMIN, checked at read time (a demoted
//      admin's secret closes again).
//
// The secret is deliberately NOT in `deriveCredentialPlan`: that plan is also
// the connect-flow prompt list, the attach credential gate and the
// describe-tools slot resolver, none of which may ever see it.
//
// WHO CALLS. Only @ax/mcp-oauth reads this ref. The bus cannot prove that:
// `AgentContext` carries no caller identity and `HookBus.call` records none,
// so a plugin cannot be pinned here. Rule 3 plus the proxy fold (which drops
// an `OAUTH_CLIENT_SECRET` slot) are what keep the value out of the sandbox.
//
// FAIL CLOSED, like the rules around it. Nothing here reads, returns or logs a
// secret value.
// ---------------------------------------------------------------------------

async function authorizeGlobalClientSecretRead(
  store: ConnectorStore,
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  connectorId: string,
  ref: string,
  deny: (reason: string) => AuthorizeGlobalOutput,
): Promise<AuthorizeGlobalOutput> {
  try {
    const shared = await store.getSoleSharedById(userId, connectorId);
    if (shared === null) return deny('client-secret-not-the-shared-connector');
    const { connector, ownerUserId } = shared;

    if (!namesOAuthClientSecretRef(connector.capabilities, ref)) {
      return deny('client-secret-ref-mismatch');
    }

    if (deriveCredentialPlan(connector).some((entry) => entry.ref === ref)) {
      return deny('client-secret-ref-is-a-slot');
    }

    if (!bus.hasService('auth:get-user')) return deny('no-auth-provider');
    const owner = await bus.call<{ userId: string }, AuthUserLike | null>(
      'auth:get-user',
      ctx,
      { userId: ownerUserId },
    );
    if (owner === null || owner === undefined || owner.isAdmin !== true) {
      return deny('client-secret-owner-not-admin');
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

// ---------------------------------------------------------------------------
// TASK-711 — who may read a credential stored ON AN AGENT for a connector.
//
// THE BUG THIS CLOSES. Same shape as TASK-697, one scope over. A team agent's
// shared OAuth sign-in is stored at vault scope `agent` (ownerId = the agent)
// under `account:<connectorId>`. Connector ids are unique per OWNER, not
// globally, and a user's own definition shadows a shared one with the same id
// (`getAvailableById`). So a member of a team agent could author a private
// connector named after the team's shared one, point it at a server they
// control, and `credentials:get` (user -> agent -> global) handed them the
// team's token, which the credential proxy then sent to THEIR server.
//
// THE RULE. @ax/credentials asks this hook before it takes the agent step for
// an `account:` ref. We allow it iff the ref parses as `account:<id>` /
// `account:<id>:<SLOT>` and the connector the REQUESTING user resolves for
// `<id>` is the ONE live shared definition with that id (`getSoleSharedById`).
// That is the connector every member of the agent sees under the id, so it is
// the only connector a credential stored on the agent can belong to. A private
// definition (the user's own or anyone's), two shared definitions with one id,
// or no definition at all is a deny.
//
// THE SAME RULE PICKS THE WRITE SCOPE. @ax/mcp-oauth calls this hook when a
// team-agent sign-in starts: allowed => store the token on the agent, denied =>
// store it on the signer (user scope). One predicate for both halves, so the
// writer never stores a token on an agent that no reader may then read.
//
// Deliberately NOT checked: that the connector is attached to `agentId`. The
// shared definition is the same one for every member, so reading its agent
// credential through it can only send it where the team's connector points.
// `agentId` is carried for a future (attachment-aware) provider.
//
// FAIL CLOSED, exactly like the global rule above. Nothing here reads,
// returns or logs a secret value.
// ---------------------------------------------------------------------------

export async function authorizeAgentAccountRead(
  store: ConnectorStore,
  ctx: AgentContext,
  input: AuthorizeAgentInput,
): Promise<AuthorizeAgentOutput> {
  const deny = (reason: string): AuthorizeAgentOutput => {
    ctx.logger.info('connectors_agent_credential_denied', {
      reason,
      ref: typeof input.ref === 'string' ? input.ref.slice(0, MAX_FIELD_LEN) : '',
    });
    return { allowed: false };
  };

  const { userId, agentId, ref } = input;
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > MAX_FIELD_LEN) {
    return deny('bad-user');
  }
  if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > MAX_FIELD_LEN) {
    return deny('bad-agent');
  }
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_FIELD_LEN) {
    return deny('bad-ref');
  }
  const connectorId = connectorIdOfAccountRef(ref);
  if (connectorId === null) return deny('not-a-connector-ref');

  try {
    const shared = await store.getSoleSharedById(userId, connectorId);
    if (shared === null) return deny('not-the-shared-connector');
    return { allowed: true };
  } catch (err) {
    ctx.logger.warn('connectors_agent_credential_check_failed', {
      plugin: PLUGIN_NAME,
      ref,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: false };
  }
}
