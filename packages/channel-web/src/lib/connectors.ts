/**
 * Connector admin client — typed wrappers around `/admin/connectors`.
 *
 * The connector registry's wire surface. Bridges the `connectors:*` hooks via
 * the `/admin/connectors[/:id]` REST routes registered by `@ax/connectors`
 * (TASK-98). Same path convention + CSRF posture as `lib/admin.ts`:
 *
 *   GET    /admin/connectors        → { connectors: ConnectorSummary[] }
 *   POST   /admin/connectors        body: ConnectorUpsertInput → { connector, created }
 *   GET    /admin/connectors/:id    → { connector: Connector }
 *   PATCH  /admin/connectors/:id    body: Partial<ConnectorUpsertInput> → { connector, created }
 *   DELETE /admin/connectors/:id    → 204
 *
 * SECURITY — every endpoint is guarded server-side by `auth:require-user`; the
 * connector is owner-scoped to the calling user. The actor id is forced from the
 * session server-side, never the body. A connector declares credential SLOT
 * names only — never values; the secret resolves inside the sandbox proxy.
 *
 * CSRF — state-changing methods carry `X-Requested-With: ax-admin`, same as
 * `lib/admin.ts`.
 */

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
};

/**
 * The mechanism-agnostic capability fill (mirrors @ax/skills-parser's
 * Capabilities). The BACKING-MECHANISM vocabulary (transport / command / url /
 * args / mcpServers) lives ONLY inside this opaque object — surfaced in the UI
 * exclusively behind the "Advanced" affordance.
 */
export interface ConnectorMcpServerSpec {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  allowedHosts: string[];
  credentials: ConnectorCredentialSlot[];
}

export interface ConnectorCredentialSlot {
  slot: string;
  kind: 'api-key';
  description?: string;
  account?: string;
}

export interface ConnectorCapabilities {
  allowedHosts: string[];
  credentials: ConnectorCredentialSlot[];
  mcpServers: ConnectorMcpServerSpec[];
  packages: { npm: string[]; pypi: string[] };
}

export type ConnectorKeyMode = 'personal' | 'workspace';
export type ConnectorVisibility = 'private' | 'shared';

/** Metadata-only descriptor for the list view (no capabilities — those load on
 *  demand via {@link getConnector}). */
export interface ConnectorSummary {
  id: string;
  name: string;
  description: string;
  usageNote: string;
  keyMode: ConnectorKeyMode;
  visibility: ConnectorVisibility;
  createdAt: string;
  updatedAt: string;
}

/** The full connector, including the opaque capabilities fill. */
export interface Connector extends ConnectorSummary {
  capabilities: ConnectorCapabilities;
  defaultAttached: boolean;
}

/** Create/update body. `connectorId` is the stable slug; required on create. */
export interface ConnectorUpsertInput {
  connectorId: string;
  name: string;
  description?: string;
  usageNote?: string;
  keyMode: ConnectorKeyMode;
  visibility: ConnectorVisibility;
  capabilities: ConnectorCapabilities;
  defaultAttached?: boolean;
}

export async function listConnectors(): Promise<ConnectorSummary[]> {
  const res = await fetch('/admin/connectors', { credentials: 'include' });
  if (!res.ok) throw new Error(`list connectors: ${res.status}`);
  const body = (await res.json()) as { connectors: ConnectorSummary[] };
  return body.connectors;
}

export async function getConnector(id: string): Promise<Connector> {
  const res = await fetch(`/admin/connectors/${encodeURIComponent(id)}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`get connector: ${res.status}`);
  const body = (await res.json()) as { connector: Connector };
  return body.connector;
}

export async function createConnector(
  input: ConnectorUpsertInput,
): Promise<Connector> {
  const res = await fetch('/admin/connectors', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    throw new Error(messageFrom(excerpt) || `create connector: ${res.status}`);
  }
  const body = (await res.json()) as { connector: Connector };
  return body.connector;
}

export async function patchConnector(
  id: string,
  patch: Partial<ConnectorUpsertInput>,
): Promise<Connector> {
  const res = await fetch(`/admin/connectors/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    throw new Error(messageFrom(excerpt) || `patch connector: ${res.status}`);
  }
  const body = (await res.json()) as { connector: Connector };
  return body.connector;
}

export async function deleteConnector(id: string): Promise<void> {
  const res = await fetch(`/admin/connectors/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-requested-with': 'ax-admin' },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`delete connector: ${res.status}`);
}

/**
 * The connector Test probe verdict (TASK-108 — the connector equivalent of the
 * old MCP `/test`). `reachable` = set up to work; `unreachable` = config is
 * malformed or its keys couldn't be verified; `needs-key` = a required
 * credential slot is still empty. The server probes credential PRESENCE +
 * config sanity — it never opens an outbound connection, and the response never
 * carries a secret.
 */
export type ConnectorTestStatus = 'reachable' | 'unreachable' | 'needs-key';

export interface ConnectorTestResult {
  status: ConnectorTestStatus;
  detail?: string;
}

/**
 * Probe a connector. Like the old `testMcpServer`, this is NON-throwing: an HTTP
 * or network failure folds into `{ status: 'unreachable', detail }` so the Test
 * badge can surface it inline instead of becoming an unhandled rejection.
 */
export async function testConnector(id: string): Promise<ConnectorTestResult> {
  try {
    const res = await fetch(`/admin/connectors/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      headers: { 'x-requested-with': 'ax-admin' },
      credentials: 'include',
    });
    if (!res.ok) {
      return { status: 'unreachable', detail: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as ConnectorTestResult;
    return body;
  } catch (err) {
    return {
      status: 'unreachable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** An empty capability fill — the default for a fresh connector. */
export function emptyCapabilities(): ConnectorCapabilities {
  return {
    allowedHosts: [],
    credentials: [],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  };
}

// ---------------------------------------------------------------------------
// Credential-plan + consent derivation (TASK-96 / connect flow, design Phase 3).
//
// SOURCE OF TRUTH: `@ax/connectors` `credential-plan.ts`. These are re-declared
// LOCALLY — a runtime cross-plugin import of `@ax/connectors` is forbidden
// (CLAUDE.md invariant 2; it is NOT on eslint's runtime-import allowlist, and
// channel-web does not even devDepend on it). This is the SAME posture as the
// local `refForDestination` re-declaration in `lib/credentials.ts`: a pure
// string/scope computation with no side effects, pinned against the canonical
// behavior by `__tests__/connectors-credential-plan.test.ts`. If the upstream
// derivation changes the scope mapping, ref shape, consent rule, or the consent
// COPY, update BOTH this module and that test.
//
// THE DERIVATION. `keyMode` decides WHOSE key the connect flow prompts for /
// spends — reach derives PURELY from where the key attaches (no visibility flag
// on a credential):
//   'personal'  → credential scope 'user'   — each user supplies their own key
//                 the first time (per-user JIT `account:<service>` vault).
//   'workspace' → credential scope 'global' — an admin supplies ONE company key;
//                 every allowed agent spends it as a shared service identity.
// Both modes use the SAME `account:<service>` ref — only the SCOPE differs.
// ---------------------------------------------------------------------------

/** The credential scope a connector slot's key binds to (reach-by-attachment).
 *  The connect flow only ever produces 'user' (personal) or 'global' (workspace). */
export type ConnectorCredentialScope = 'user' | 'global';

/** One derived credential binding: which scope + vault ref a connector slot spends. */
export interface ConnectorCredentialPlanEntry {
  /** The capability slot name this binding satisfies. */
  slot: string;
  /** The credential scope the key binds to — reach derives from this alone. */
  scope: ConnectorCredentialScope;
  /** The deterministic vault ref the proxy resolves (`account:<service>`). */
  ref: string;
}

/**
 * The service tag for a slot — the `<service>` in `account:<service>`. Prefers
 * the slot's declared `account` (share-by-service), falling back to the connector
 * id when a slot omits it (or declares it empty), so a slotless-account connector
 * still gets a stable per-service vault key. Mirrors `serviceTagForSlot` upstream.
 */
export function serviceTagForSlot(
  slot: ConnectorCredentialSlot,
  connectorId: string,
): string {
  return slot.account !== undefined && slot.account.length > 0
    ? slot.account
    : connectorId;
}

/** Build the per-user / company vault ref for a service (`account:<service>`).
 *  Identical to `refForDestination({kind:'account', service})`. */
export function accountRef(service: string): string {
  return `account:${service}`;
}

/** keyMode → the credential scope the key attaches to (reach-by-attachment). */
function scopeForKeyMode(keyMode: ConnectorKeyMode): ConnectorCredentialScope {
  return keyMode === 'workspace' ? 'global' : 'user';
}

/**
 * Derive one credential-plan entry per declared credential slot. The connect flow
 * uses this to know WHOSE key to prompt for / spend: a `personal` connector
 * resolves every slot to the per-user vault (`scope:'user'`), a `workspace`
 * connector to the single company key (`scope:'global'`). A connector with no
 * credential slots yields an empty plan (nothing to prompt — e.g. an MCP server
 * that needs no key); the connect flow treats that as "connected, needs no key".
 */
export function deriveCredentialPlan(
  connector: Connector,
): ConnectorCredentialPlanEntry[] {
  const scope = scopeForKeyMode(connector.keyMode);
  return connector.capabilities.credentials.map((slot) => ({
    slot: slot.slot,
    scope,
    ref: accountRef(serviceTagForSlot(slot, connector.id)),
  }));
}

/**
 * Whether connecting this connector must surface the shared-key consent moment
 * BEFORE the key becomes spendable. True iff the resolved key is spendable by an
 * identity the keyholder doesn't solely control:
 *   - `keyMode === 'workspace'` — one key, every allowed agent spends it, OR
 *   - `visibility === 'shared'` — bound to a shared / team agent.
 * `personal` + `private` → false (you only ever act as yourself; no consent needed).
 */
export function requiresSharedKeyConsent(connector: Connector): boolean {
  return connector.keyMode === 'workspace' || connector.visibility === 'shared';
}

/**
 * The shared-key consent copy (design "Consent caveat", invariant #5). The proxy
 * stops key THEFT, not authorized MISUSE — sharing a key for USE lets anyone who
 * can drive a shared agent act as that identity. `%SERVICE%` is filled by
 * {@link sharedKeyConsentMessage}. This wording is a SECURITY contract, not
 * throwaway copy — it must match `@ax/connectors`'s `SHARED_KEY_CONSENT_COPY`
 * verbatim (pinned by the credential-plan test).
 */
export const SHARED_KEY_CONSENT_COPY =
  "Sharing this key lets their assistant act as you on %SERVICE%. They can't copy the key — but they can use it.";

/** Fill the consent copy with a concrete service name. */
export function sharedKeyConsentMessage(service: string): string {
  return SHARED_KEY_CONSENT_COPY.replace('%SERVICE%', service);
}

/** Extract a server `{ error }` message from a response body excerpt. */
function messageFrom(excerpt: string): string {
  try {
    return (JSON.parse(excerpt) as { error?: string }).error ?? '';
  } catch {
    return excerpt;
  }
}
