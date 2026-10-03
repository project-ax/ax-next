// ---------------------------------------------------------------------------
// TASK-712 — the only `clientSecretRef` `begin` will dereference.
//
// `begin` hands the ref to `credentials:get` and posts the resolved value, as HTTP
// Basic auth, to the `token_endpoint` of an authorization server the connector's
// AUTHOR chose. The author is any signed-in user, so the ref is attacker-controlled
// text: `provider:anthropic` would post the operator's model key to a host the
// author owns. What kept that from happening on main was an accident (`begin`'s
// placeholder agentId `'@ax/mcp-oauth'` makes the vault's agent-scope step throw
// before the global step or the env fallback), and a refactor that gave `begin` a
// real or empty agentId would have removed it. This makes it a control.
//
// A client secret is stored by the connector's own edit dialog at
// `account:<connectorId>:<tag>` (the editors write `OAUTH_CLIENT_SECRET`; before
// TASK-762 they named `oauth-client-secret`, which the credential route refused), so that
// is the only shape allowed:
//   - `account:` only (`provider:` / `mcp:` / env-fallback refs are the operator's);
//   - THIS connector's id, so TASK-697's `credentials:authorize-global:account` guard
//     decides what a global-scope step may do with it;
//   - a tag is required: the bare `account:<connectorId>` is where the OAuth callback
//     stores this connector's TOKEN (per user or per team agent), never a client
//     secret.
//
// This is a LOCAL COPY of @ax/connectors' `isOwnClientSecretRef`
// (packages/connectors/src/oauth-client-secret-ref.ts), which enforces the same rule
// when a connector is written. Invariant 2 forbids importing it, and this copy is
// the one that matters: it covers rows written before that check existed. Keep the
// two grammars in step.
// ---------------------------------------------------------------------------

const ACCOUNT_PREFIX = 'account:';
// One tag segment: no ':' (the ref separator), no '.' or '/'.
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Is `ref` exactly `account:<connectorId>:<tag>`? Pure; anything else is `false`. */
export function isOwnClientSecretRef(connectorId: string, ref: unknown): boolean {
  if (typeof ref !== 'string' || connectorId.length === 0) return false;
  const prefix = `${ACCOUNT_PREFIX}${connectorId}:`;
  if (!ref.startsWith(prefix)) return false;
  return TAG_RE.test(ref.slice(prefix.length));
}
