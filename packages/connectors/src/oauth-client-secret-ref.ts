import { PluginError } from '@ax/core';

// ---------------------------------------------------------------------------
// TASK-712 — an OAuth slot's `clientSecretRef` may name only THIS connector's own
// account key.
//
// THE HOLE. `OAuthSlotSchema.clientSecretRef` is a free string, and a connector is
// authored by whoever is signed in (`POST /settings/connectors`). @ax/mcp-oauth's
// `begin` runs `credentials:get` on that ref and sends the resolved value as HTTP
// Basic auth to the `token_endpoint` of an authorization server the SAME author
// chose. So `provider:anthropic` (the operator's model key), an env-fallback ref, or
// anyone else's `account:*` ref would have been posted to a host the author
// controls. It did not leak on main only because `begin` builds its ctx with the
// placeholder agentId `'@ax/mcp-oauth'`, whose `/` fails the vault's `ownerId`
// grammar, so the agent-scope step of `credentials:get` throws before the global
// step or the env fallback is reached. An accident, not a control.
//
// THE RULE. A client secret is stored by the connector's own edit dialog at
// `account:<connectorId>:<tag>` (the editors write `OAUTH_CLIENT_SECRET`; before TASK-762
// they named `oauth-client-secret`, which the credential route refused). That
// is the only namespace an OAuth slot may name:
//
//   - `account:` only. `provider:` / `mcp:` / `skill:` / `routine:` refs are minted
//     by the platform and hold the OPERATOR's credentials; an env-fallback name is
//     an operator secret too.
//   - the id must be THIS connector's. Someone else's `account:<id>` is theirs.
//   - a tag is REQUIRED. The bare `account:<connectorId>` is where the OAuth
//     callback stores the connector's TOKEN (per user, or per team agent), and where
//     a workspace-keyed connector's company key lives. A client secret has no
//     business there, and at agent scope that row belongs to whoever connected the
//     agent, not to the author of a same-id connector.
//
// Because the ref then always addresses `account:<this connector>:...`, TASK-697's
// `credentials:authorize-global:account` guard applies to whatever `credentials:get`
// does with it, whichever agentId ends up on the ctx.
//
// WRITE-TIME ONLY, DELIBERATELY. This is checked where a connector is WRITTEN
// (`connectors:upsert`), not in `CapabilitiesSchema`: that schema also parses every
// stored row on READ, so a refine there would make an existing row with a foreign
// ref unreadable (the owner could not even open it to fix it). @ax/mcp-oauth
// re-checks the same rule at `begin`, so a row that predates this check is refused
// where the ref is actually dereferenced. That check is a local copy of this
// grammar (invariant 2: no cross-plugin import); keep the two in step.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/connectors';
const ACCOUNT_PREFIX = 'account:';
// `account:<id>:<tag>` — one tag segment, no ':' (the ref separator), no '.' or '/'.
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Is `ref` an account ref of connector `connectorId` carrying a tag,
 * i.e. `account:<connectorId>:<tag>`? Pure and total: any input that is not
 * exactly that is `false`.
 */
export function isOwnClientSecretRef(connectorId: string, ref: unknown): boolean {
  if (typeof ref !== 'string' || connectorId.length === 0) return false;
  const prefix = `${ACCOUNT_PREFIX}${connectorId}:`;
  if (!ref.startsWith(prefix)) return false;
  return TAG_RE.test(ref.slice(prefix.length));
}

interface SlotLike {
  kind?: unknown;
  slot?: unknown;
  clientSecretRef?: unknown;
}

function* oauthSlotsWithRef(capabilities: {
  credentials?: unknown;
  mcpServers?: unknown;
}): Generator<SlotLike> {
  const lists: unknown[] = [capabilities.credentials];
  // A server-level credential list uses the same slot union. Nothing reads it for
  // OAuth today, so a ref parked there is dead; checking it anyway means it can
  // never become live by a later consumer without also passing this rule.
  if (Array.isArray(capabilities.mcpServers)) {
    for (const server of capabilities.mcpServers) {
      lists.push((server as { credentials?: unknown } | null)?.credentials);
    }
  }
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const slot of list as SlotLike[]) {
      // Truthiness, not `!== undefined`: @ax/mcp-oauth dereferences a ref only when
      // it is truthy (`''` means "no pinned secret"), so the two checks agree on
      // exactly which values reach `credentials:get`.
      if (slot?.kind === 'oauth' && slot.clientSecretRef) yield slot;
    }
  }
}

/**
 * Throw `invalid-payload` if any OAuth slot in `capabilities` names a
 * `clientSecretRef` other than `account:<connectorId>:<tag>`. The message names
 * the slot and the allowed shape and never echoes the offending ref (it is
 * author-controlled text, and could itself be a credential someone pasted).
 */
export function assertOwnClientSecretRefs(
  connectorId: string,
  capabilities: { credentials?: unknown; mcpServers?: unknown },
): void {
  for (const slot of oauthSlotsWithRef(capabilities)) {
    if (isOwnClientSecretRef(connectorId, slot.clientSecretRef)) continue;
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: 'connectors:upsert',
      message:
        `oauth slot '${String(slot.slot)}': clientSecretRef must be this ` +
        `connector's own account key, 'account:${connectorId}:<name>'`,
    });
  }
}
