/**
 * Connector client — typed wrappers around the connector REST routes.
 *
 * The connector registry's wire surface. Bridges the `connectors:*` hooks via
 * REST routes registered by `@ax/connectors`. There are TWO owner-scoped route
 * bundles, selected by {@link ConnectorRouteBase} (TASK-129):
 *
 *   - `/admin/connectors`    — the folded admin Connector registry (TASK-98).
 *     The admin may set `visibility: 'shared'` + `defaultAttached: true`.
 *   - `/settings/connectors` — user authoring (TASK-129). Owner forced to the
 *     caller, `visibility` forced `private`, admin-only fields REJECTED
 *     server-side, catalog/shared connectors read-only (403).
 *
 * Both bundles share the same path shape + CSRF posture as `lib/admin.ts`:
 *
 *   GET    <base>        → { connectors: ConnectorSummary[] }
 *   POST   <base>        body: ConnectorUpsertInput → { connector, created }
 *   GET    <base>/:id    → { connector: Connector }
 *   PATCH  <base>/:id    body: Partial<ConnectorUpsertInput> → { connector, created }
 *   DELETE <base>/:id    → 204
 *
 * `base` defaults to `/admin/connectors` for back-compat; the user surface
 * passes `/settings/connectors`. (The Test probe is admin-only — it lives only
 * under `/admin/connectors/:id/test`, never the user base.)
 *
 * SECURITY — every endpoint is guarded server-side by `auth:require-user`; the
 * connector is owner-scoped to the calling user. The actor id is forced from the
 * session server-side, never the body. The user routes additionally force
 * `visibility: private` + reject admin-only fields server-side, so the UI
 * forcing is belt-and-braces, not the security boundary. A connector declares
 * credential SLOT names only — never values; the secret resolves inside the
 * sandbox proxy.
 *
 * CSRF — state-changing methods carry `X-Requested-With: ax-admin`, same as
 * `lib/admin.ts`.
 */

// TASK-154 — the neutral dev-service descriptor. Type-only import of the
// canonical shape from the pure-parser package @ax/skills-parser (allowed by the
// eslint runtime-import allowlist; here we only need the TYPE, which is erased).
// A connector's declared services ride its opaque `capabilities` fill, exactly
// like mcpServers/packages.
import type { ServiceDescriptor } from '@ax/skills-parser';

/** Re-export so consumers in channel-web (the form, the dialog) reference one
 *  descriptor type. */
export type { ServiceDescriptor };

/** Which owner-scoped route bundle a call targets (TASK-129). */
export type ConnectorRouteBase = '/admin/connectors' | '/settings/connectors';

/** Default route bundle — the admin registry (back-compat). */
const DEFAULT_BASE: ConnectorRouteBase = '/admin/connectors';

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

export interface ConnectorApiKeySlot {
  slot: string;
  kind: 'api-key';
  description?: string;
  // No share-by-service `account` tag — each connector owns its own key, keyed by
  // the connector id (mirrors @ax/connectors' CapabilitySlot). The server strips
  // any legacy `account` on read, so it never reaches the client.
}

export interface ConnectorOAuthSlot {
  slot: string;
  kind: 'oauth';
  /** The OAuth server / provider identity (e.g. 'example', 'github'). */
  server: string;
  /** Requested OAuth scopes. */
  scopes?: string[];
  /** Optional OAuth client id — overrides the server-level default. */
  clientId?: string;
  /** Vault ref where the client secret lives (never the raw secret). */
  clientSecretRef?: string;
  /** Authorization server URL (if not derived from `server`). */
  authServerUrl?: string;
  /** Token endpoint URL (if not derived from `server`). */
  tokenUrl?: string;
}

export type ConnectorCredentialSlot = ConnectorApiKeySlot | ConnectorOAuthSlot;

export interface ConnectorCapabilities {
  allowedHosts: string[];
  credentials: ConnectorCredentialSlot[];
  mcpServers: ConnectorMcpServerSpec[];
  packages: { npm: string[]; pypi: string[] };
  /**
   * TASK-154 — declared dev SERVICES (a "service bundle" connector). Each names
   * a digest-pinned image + ports/env/writablePaths the unit of work wants
   * alongside its sandbox; the orchestrator folds them onto `sandbox:open-session`
   * (TASK-153). OPTIONAL on the wire so existing capability literals + legacy rows
   * compile/round-trip unchanged — the server's `CapabilitiesSchema` defaults it
   * to `[]`. Never carries a secret: service `env` is author-declared config (a
   * secret is a `credentials` SLOT name, resolved by the proxy inside the sandbox).
   */
  services?: ServiceDescriptor[];
}

export type ConnectorKeyMode = 'personal' | 'workspace';
export type ConnectorVisibility = 'private' | 'shared';

/** Metadata-only descriptor for the list view (no capabilities — those load on
 *  demand via {@link getConnector}). `defaultAttached` is the admin
 *  workspace-default flag, surfaced here (TASK-110) so the user list can badge a
 *  default-on connector as "Catalog" even when its `visibility` is `private`. */
export interface ConnectorSummary {
  id: string;
  name: string;
  description: string;
  usageNote: string;
  keyMode: ConnectorKeyMode;
  visibility: ConnectorVisibility;
  defaultAttached: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The full connector, including the opaque capabilities fill. */
export interface Connector extends ConnectorSummary {
  capabilities: ConnectorCapabilities;
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

export async function listConnectors(
  base: ConnectorRouteBase = DEFAULT_BASE,
): Promise<ConnectorSummary[]> {
  const res = await fetch(base, { credentials: 'include' });
  if (!res.ok) throw new Error(`list connectors: ${res.status}`);
  const body = (await res.json()) as { connectors: ConnectorSummary[] };
  return body.connectors;
}

export async function getConnector(
  id: string,
  base: ConnectorRouteBase = DEFAULT_BASE,
): Promise<Connector> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`get connector: ${res.status}`);
  const body = (await res.json()) as { connector: Connector };
  return body.connector;
}

export async function createConnector(
  input: ConnectorUpsertInput,
  base: ConnectorRouteBase = DEFAULT_BASE,
): Promise<Connector> {
  const res = await fetch(base, {
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
  base: ConnectorRouteBase = DEFAULT_BASE,
): Promise<Connector> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}`, {
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

export async function deleteConnector(
  id: string,
  base: ConnectorRouteBase = DEFAULT_BASE,
): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-requested-with': 'ax-admin' },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`delete connector: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Authored-connector drafts (the Settings "Proposed by your assistant" fallback,
// 2026-06-03). A connector the assistant proposed mid-turn lands as a PENDING
// authored draft; the approval card surfaces it in chat, but if that's missed
// the user can list + approve drafts here too. Always the owner-scoped
// `/settings/connectors/authored` surface (the route is owner-scoped by session,
// so admins use it too — it's about "what my assistant proposed", not curation).
// ---------------------------------------------------------------------------

/** One pending authored draft surfaced for the Settings fallback. `agentId` is
 *  the agent that authored it — needed by the approve call (the user no longer
 *  picks the agent). `proposal` is the declared, UNAPPROVED capability surface. */
export interface PendingAuthoredConnector {
  connectorId: string;
  agentId: string;
  name: string;
  usageNote: string;
  keyMode: ConnectorKeyMode;
  status: 'pending';
  proposal: ConnectorCapabilities;
}

/** List the session user's pending authored connector drafts across all their
 *  agents. A preset without the connectors plugin returns an empty list (the
 *  shelf renders nothing). */
export async function listAuthoredPending(): Promise<PendingAuthoredConnector[]> {
  const res = await fetch('/settings/connectors/authored', { credentials: 'include' });
  if (!res.ok) throw new Error(`list proposed connectors: ${res.status}`);
  const body = (await res.json()) as { drafts: PendingAuthoredConnector[] };
  return body.drafts;
}

/** What the approval card displayed — the TOCTOU narrowing guard forwarded to
 *  the grant (it can only NARROW the re-resolved proposal, never widen it). */
export interface AuthoredApprovalShown {
  hosts: string[];
  slots: string[];
  npm: string[];
  pypi: string[];
}

/**
 * Approve a pending authored connector draft outside chat. The caller must have
 * already written any required key(s) to the vault (`setDestinationCredential`),
 * exactly like the in-chat card. `agentId` comes from the listed draft. No secret
 * crosses this call — only domain ids + the shown guard.
 */
export async function approveAuthoredConnector(
  connectorId: string,
  args: { agentId: string; shown: AuthoredApprovalShown },
): Promise<void> {
  const res = await fetch(
    `/settings/connectors/authored/${encodeURIComponent(connectorId)}/approve`,
    {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify({ agentId: args.agentId, shown: args.shown }),
    },
  );
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    throw new Error(messageFrom(excerpt) || `approve connector: ${res.status}`);
  }
}

/**
 * Dismiss a pending authored connector draft (the "Proposed by your assistant"
 * shelf, 2026-06-04). Rejects the proposal outright — no approve, no key entry.
 * `agentId` comes from the listed draft (the composite key the clear scopes to).
 *
 * A 404 is treated as success: DELETE is idempotent, and a draft that's already
 * gone (a double-click, or it was approved/re-proposed in another tab) is the
 * exact end state the user asked for. Only an unexpected status throws.
 */
export async function rejectAuthoredConnector(
  connectorId: string,
  args: { agentId: string },
): Promise<void> {
  const res = await fetch(
    `/settings/connectors/authored/${encodeURIComponent(connectorId)}`,
    {
      method: 'DELETE',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify({ agentId: args.agentId }),
    },
  );
  if (res.ok || res.status === 404) return;
  const excerpt = await res.text().catch(() => '');
  throw new Error(messageFrom(excerpt) || `dismiss connector: ${res.status}`);
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
  /**
   * The deterministic vault ref the proxy resolves. `account:<service>` for a
   * single-slot connector (back-compat); `account:<service>:<slot>` for a
   * multi-slot connector (TASK-124 — per-slot refs, no collision).
   */
  ref: string;
  /**
   * The `<service>` tag inside the ref. Carried structurally (TASK-124) so the
   * connect dialog rebuilds the `{kind:'account', service, slot?}` destination
   * WITHOUT string-parsing the `:`-bearing ref. Always present.
   */
  service: string;
  /**
   * The `<slot>` tag inside the ref, present IFF the per-slot ref form is used
   * (multi-slot connector). Passed as the optional `slot` on the account
   * destination; absent ⟹ the collapsed `account:<service>` ref.
   */
  slotTag?: string;
}

/**
 * The service tag for a slot — the `<service>` in `account:<service>`. Each
 * connector owns its own key(s): the tag is ALWAYS the connector id (no
 * share-by-service). Mirrors `serviceTagForSlot` upstream EXACTLY — the connect
 * flow WRITE (this module) and the host-resolver READ must agree. `_slot` is
 * retained for signature stability but no longer consulted.
 */
export function serviceTagForSlot(
  _slot: ConnectorCredentialSlot,
  connectorId: string,
): string {
  return connectorId;
}

/** Build the per-user / company vault ref for a service. Identical to
 *  `refForDestination({kind:'account', service, slot?})`. TASK-124 — pass `slot`
 *  for a multi-slot connector (→ `account:<service>:<slot>`); omit it for a
 *  single-slot connector (→ collapsed `account:<service>`, back-compat). */
export function accountRef(service: string, slot?: string): string {
  return slot !== undefined ? `account:${service}:${slot}` : `account:${service}`;
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
  // TASK-124 — the collapse-vs-expand rule keys on the connector's slot COUNT
  // (mirrors @ax/connectors): exactly 1 slot keeps `account:<service>`; ≥2 slots
  // derive a distinct `account:<service>:<slot>` per slot (fixes the collision).
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

/** Where a connector's secret actually lands — the truthful, plain-language
 *  hint shown beneath each per-slot key field on the Credentials "Add a key"
 *  surface (TASK-132). */
export type MechanismHint = 'env var' | 'header' | 'request auth';

/**
 * Derive the truthful mechanism hint for a connector's credential slots
 * (TASK-132). A connector's backing mechanism is connector-level — the admin
 * Connector registry form edits a SINGLE leading mcpServer — so the hint keys off
 * that leading server's transport, or falls back to Direct API when the connector
 * has no MCP backing at all:
 *   - stdio MCP → the secret is injected as an environment variable ("env var");
 *   - http MCP  → the secret is sent as an HTTP request header ("header");
 *   - no MCP    → Direct API: the secret is used in the request's auth ("request auth").
 *
 * This is a USER-FACING security-relevant label: it tells the keyholder where
 * their secret is actually used. Pinned by `connectors-credential-plan.test.ts`.
 */
export function mechanismHint(connector: Connector): MechanismHint {
  const transport = connector.capabilities.mcpServers[0]?.transport;
  if (transport === 'stdio') return 'env var';
  if (transport === 'http') return 'header';
  return 'request auth';
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
