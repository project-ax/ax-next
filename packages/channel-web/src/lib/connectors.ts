/**
 * Connector client — typed wrappers around the connector REST routes.
 *
 * Shared definitions are readable by all signed-in users. Only admins write
 * connector definitions (slice 2a): writes go to `/admin/connectors`, which is
 * ADMIN-ONLY server-side (403 for a signed-in non-admin, TASK-698). Any admin
 * may edit or delete a shared connector; a non-owner admin may only relabel it
 * (see {@link OWNER_ONLY_CHANGE}). `/settings/connectors` is the READ bundle
 * any signed-in user can reach (list + show).
 *
 *   GET    <base>        → { connectors: ConnectorSummary[] }
 *   GET    <base>/:id    → { connector: Connector }
 *   POST   /admin/connectors        body: ConnectorUpsertInput → { connector, created }
 *          (create only — a live id, the caller's own included, is a 409)
 *   PATCH  /admin/connectors/:id    body: Partial<ConnectorUpsertInput> → { connector, created }
 *   DELETE /admin/connectors/:id    → 204
 *
 * `base` is REQUIRED on every call — there is no default (TASK-714). A default
 * of `/admin/connectors` was a trap: a new read a non-admin can reach would
 * silently 403. Each read names its bundle — `/settings/connectors` for anything
 * a non-admin can reach, `/admin/connectors` only from admin-only surfaces. The
 * write helpers take {@link ConnectorWriteBase}, so they can only target the
 * admin bundle. (The Test probe is admin-only too — it lives only under
 * `/admin/connectors/:id/test`.)
 *
 * SECURITY — actor identity comes from the session, never the request body.
 * Shared definitions contain credential references, never secret values.
 * Personal credentials remain scoped to the user connecting the service.
 *
 * CSRF — state-changing methods carry `X-Requested-With: ax-admin`, same as
 * `lib/admin.ts`.
 */

// TASK-154 — the neutral dev-service descriptor. A RUNTIME import from the
// pure-parser package @ax/skills-parser (allowed by the eslint runtime-import
// allowlist): the schema validates services carried over from an agent's
// request, and the type is the canonical shape.
// A connector's declared services ride its opaque `capabilities` fill, exactly
// like mcpServers/packages.
import { ServiceDescriptorSchema, type ServiceDescriptor } from '@ax/skills-parser';
import { TOOL_PERMISSIONS_RESET_FAILED } from '@ax/core/error-codes';

/** Re-export so consumers in channel-web (the form, the dialog) reference one
 *  descriptor type. */
export type { ServiceDescriptor };

/** Which route bundle a READ targets (TASK-129). */
export type ConnectorRouteBase = '/admin/connectors' | '/settings/connectors';

/** The only bundle with write routes (slice 2a): writes are admin-only. */
export type ConnectorWriteBase = '/admin/connectors';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
};

/**
 * The mechanism-agnostic capability fill (mirrors @ax/skills-parser's
 * Capabilities). The BACKING-MECHANISM vocabulary (transport / url /
 * mcpServers) lives ONLY inside this opaque object — surfaced in the UI
 * exclusively behind the "Advanced" affordance.
 */
export interface ConnectorMcpServerSpec {
  name: string;
  transport: 'http';
  url?: string;
  allowedHosts: string[];
  credentials: ConnectorCredentialSlot[];
}

export interface ConnectorApiKeySlot {
  slot: string;
  kind: 'api-key';
  description?: string;
  headerName?: string;
  server?: string;
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
  clientRegistration?: 'auto' | 'cimd' | 'dcr' | 'custom';
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
 *  demand via {@link getConnector}). */
export interface ConnectorSummary {
  /** Server-derived permission for the authenticated caller. */
  canEdit?: boolean;
  /** Skip legacy implicit owner attachment; explicit attachments still apply. */
  requiresAttachment?: boolean;
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
}

export async function listConnectors(
  base: ConnectorRouteBase,
): Promise<ConnectorSummary[]> {
  const res = await fetch(base, { credentials: 'include' });
  if (!res.ok) throw new Error(`list connectors: ${res.status}`);
  const body = (await res.json()) as { connectors: ConnectorSummary[] };
  return body.connectors;
}

export async function getConnector(
  id: string,
  base: ConnectorRouteBase,
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
  base: ConnectorWriteBase,
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
  base: ConnectorWriteBase,
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

/**
 * TASK-758 — the `error` a connector save answers (503) when it pointed a
 * server at a new address but couldn't first reset that server's tool
 * permissions. The server refused the whole save, so nothing changed: the old
 * address is still in use, with the choices people made for it. TASK-809: a
 * save (create included) also answers this when it couldn't record which of
 * the connector's servers have an admin ceiling — same refusal, same retry,
 * so the copy names neither cause.
 *
 * Defined once in `@ax/core/error-codes` (TASK-782) — the producer
 * (`@ax/connectors`) and `server/routes-chat.ts` import the same constant, so
 * the code the server answers and the code this file keys on cannot drift.
 * Re-exported here so the editors keep one import site.
 */
export { TOOL_PERMISSIONS_RESET_FAILED };

/** What the editors say for {@link TOOL_PERMISSIONS_RESET_FAILED}. */
export const TOOL_PERMISSIONS_RESET_FAILED_MESSAGE =
  'We couldn’t update this server’s tool permissions, so we didn’t save your changes. Your saved settings are unchanged. Try saving again in a moment.';

/** True when a {@link createConnector} / {@link patchConnector} failure is the
 *  reset refusal. */
export function isToolPermissionsResetFailure(err: unknown): boolean {
  return err instanceof Error && err.message === TOOL_PERMISSIONS_RESET_FAILED;
}

/**
 * Slice 2a — what `PATCH /admin/connectors/:id` answers (403) when an admin
 * who didn't create a shared connector tries to change where it connects
 * (its capabilities, whose key it uses, or who can see it). Relabelling is
 * fine; retargeting is the creator's call. Mirrors `@ax/connectors`
 * `admin-routes.ts`.
 */
export const OWNER_ONLY_CHANGE = 'owner-only-change';

/** What the editors say for {@link OWNER_ONLY_CHANGE}. */
export const OWNER_ONLY_CHANGE_MESSAGE =
  'Only the admin who created this connector can change where it connects. To point it somewhere else, delete it and add a new one.';

/** True when a {@link patchConnector} failure is the owner-only refusal. */
export function isOwnerOnlyChange(err: unknown): boolean {
  return err instanceof Error && err.message === OWNER_ONLY_CHANGE;
}

/**
 * What {@link deleteConnector} throws when the connector is already gone (the
 * route's 404): usually another admin removed it a moment earlier.
 */
export const CONNECTOR_GONE = 'connector-gone';

/** What the list says for {@link CONNECTOR_GONE}. */
export const CONNECTOR_GONE_MESSAGE = 'Someone already removed this connector.';

/** True when a {@link deleteConnector} failure means it was already removed. */
export function isConnectorGone(err: unknown): boolean {
  return err instanceof Error && err.message === CONNECTOR_GONE;
}

export async function deleteConnector(
  id: string,
  base: ConnectorWriteBase,
): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-requested-with': 'ax-admin' },
    credentials: 'include',
  });
  if (res.status === 404) throw new Error(CONNECTOR_GONE);
  if (!res.ok) throw new Error(`delete connector: ${res.status}`);
}

/**
 * Slice 2c — what `POST /admin/connectors` answers (409) when a connector with
 * that id already exists. "Set it up" creates under the requested id (that is
 * what clears the request), so this is the one create refusal a prefilled
 * editor can expect. Mirrors `@ax/connectors` `admin-routes.ts`.
 */
export const CONNECTOR_ID_TAKEN = 'connector-id-taken';

/** What the editors say for {@link CONNECTOR_ID_TAKEN}. */
export const CONNECTOR_ID_TAKEN_MESSAGE = 'A connector with this id already exists.';

/** The same, on an editor opened by "Set it up" from a request. */
export const CONNECTOR_ID_TAKEN_REQUEST_MESSAGE =
  'A connector with this id already exists. Dismiss this request if it’s no longer needed.';

/** True when a {@link createConnector} failure is the id-taken refusal. */
export function isConnectorIdTaken(err: unknown): boolean {
  return err instanceof Error && err.message === CONNECTOR_ID_TAKEN;
}

// ---------------------------------------------------------------------------
// Awaiting approval (slice 2c). An agent that needs a connector nobody has
// defined yet files a REQUEST; every admin sees every person's requests in
// Admin › Connectors. Approval is creation: an admin sets the connector up
// through the normal create path (`POST /admin/connectors`, shared), and the
// server clears every request with that id. Dismiss clears them without
// creating anything. Both routes are admin-only.
//
//   GET    /admin/connectors/authored              → { drafts: AuthoredProposal[] }
//   DELETE /admin/connectors/authored/:connectorId → 204
//
// UNTRUSTED: everything in a request except `proposedBy` was written by an
// agent. Render it as text only, and never carry a secret ref out of it.
// ---------------------------------------------------------------------------

/** One request in the admin "Awaiting approval" list. */
export interface AuthoredProposal {
  connectorId: string;
  name: string;
  usageNote: string;
  /** What the agent suggested for whose key — a hint; the admin decides. */
  keyMode: ConnectorKeyMode;
  /** The reach it asked for, normalized by {@link listAuthoredProposals}. */
  proposal: ConnectorCapabilities;
  updatedAt: string;
  /** Who asked: their id and a display label (name, else email, else the id). */
  proposedBy: { userId: string; label: string };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Credential slots from an agent's request, as NAMES and kinds only. A
 * `clientSecretRef` is dropped: it would point at the proposer's vault, and the
 * admin's own key choice decides where any secret lives.
 */
function proposalSlots(v: unknown): ConnectorCredentialSlot[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((raw): ConnectorCredentialSlot[] => {
    const r = record(raw);
    const slot = text(r.slot);
    if (!slot) return [];
    if (r.kind === 'oauth') {
      const server = text(r.server);
      if (!server) return [];
      const out: ConnectorOAuthSlot = { slot, kind: 'oauth', server };
      const scopes = strings(r.scopes);
      if (scopes.length) out.scopes = scopes;
      if (text(r.clientId)) out.clientId = text(r.clientId);
      const reg = r.clientRegistration;
      if (reg === 'auto' || reg === 'cimd' || reg === 'dcr' || reg === 'custom')
        out.clientRegistration = reg;
      if (text(r.authServerUrl)) out.authServerUrl = text(r.authServerUrl);
      if (text(r.tokenUrl)) out.tokenUrl = text(r.tokenUrl);
      return [out];
    }
    const out: ConnectorApiKeySlot = { slot, kind: 'api-key' };
    if (text(r.description)) out.description = text(r.description);
    if (text(r.headerName)) out.headerName = text(r.headerName);
    if (text(r.server)) out.server = text(r.server);
    return [out];
  });
}

/**
 * Shape an agent-written proposal into {@link ConnectorCapabilities}. The
 * server validated it when the request was filed; this only makes sure a
 * malformed row can't break the list (missing arrays become empty).
 */
export function normalizeProposal(raw: unknown): ConnectorCapabilities {
  const r = record(raw);
  const pkgs = record(r.packages);
  const out: ConnectorCapabilities = {
    allowedHosts: strings(r.allowedHosts),
    credentials: proposalSlots(r.credentials),
    mcpServers: (Array.isArray(r.mcpServers) ? r.mcpServers : []).flatMap((raw) => {
      const m = record(raw);
      const name = text(m.name);
      if (!name) return [];
      return [
        {
          name,
          transport: 'http' as const,
          ...(text(m.url) ? { url: text(m.url) } : {}),
          allowedHosts: strings(m.allowedHosts),
          credentials: proposalSlots(m.credentials),
        },
      ];
    }),
    packages: { npm: strings(pkgs.npm), pypi: strings(pkgs.pypi) },
  };
  // Each service is checked against the canonical descriptor; a malformed
  // one is dropped rather than cast through.
  if (Array.isArray(r.services)) {
    out.services = r.services.flatMap((svc): ServiceDescriptor[] => {
      const parsed = ServiceDescriptorSchema.safeParse(svc);
      return parsed.success ? [parsed.data] : [];
    });
  }
  return out;
}

/**
 * Every person's open connector requests (admin-only). A preset without the
 * connectors plugin answers 404 — that is an empty list. Any other failure
 * throws, so the tab can say the requests didn't load instead of quietly
 * showing none.
 */
export async function listAuthoredProposals(): Promise<AuthoredProposal[]> {
  const res = await fetch('/admin/connectors/authored', { credentials: 'include' });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`list connector requests: ${res.status}`);
  const body = (await res.json()) as { drafts?: unknown };
  const drafts = Array.isArray(body.drafts) ? body.drafts : [];
  return drafts.flatMap((raw): AuthoredProposal[] => {
    const d = record(raw);
    const connectorId = text(d.connectorId);
    if (!connectorId) return [];
    const by = record(d.proposedBy);
    const userId = text(by.userId);
    return [
      {
        connectorId,
        name: text(d.name) || connectorId,
        usageNote: text(d.usageNote),
        keyMode: d.keyMode === 'workspace' ? 'workspace' : 'personal',
        proposal: normalizeProposal(d.proposal),
        updatedAt: text(d.updatedAt),
        proposedBy: { userId, label: text(by.label) || userId },
      },
    ];
  });
}

/**
 * Dismiss: clear every person's request for this id (admin-only). The person
 * is not notified. The route is idempotent (204 whether or not a row matched).
 */
export async function dismissAuthoredProposal(connectorId: string): Promise<void> {
  const res = await fetch(
    `/admin/connectors/authored/${encodeURIComponent(connectorId)}`,
    {
      method: 'DELETE',
      headers: { 'x-requested-with': 'ax-admin' },
      credentials: 'include',
    },
  );
  if (!res.ok) throw new Error(`dismiss connector request: ${res.status}`);
}

/**
 * What "Set it up" opens the create editor with: a new connector under the
 * requested id, prefilled from the request. Nothing in it is a secret; the
 * admin's own choices in the editor decide whose key it uses.
 */
export interface ConnectorPrefill {
  connectorId: string;
  name: string;
  usageNote: string;
  /** The request's suggestion — the editor's starting point only. */
  keyMode: ConnectorKeyMode;
  capabilities: ConnectorCapabilities;
  /**
   * What the request asked for that the chosen editor does NOT show, so is NOT
   * carried (see `lib/connector-request-prefill.ts`). Plain phrases, rendered
   * as text in the editor's "This request also asked for" note.
   */
  leftOut?: string[];
}

export function prefillFromProposal(p: AuthoredProposal): ConnectorPrefill {
  return {
    connectorId: p.connectorId,
    name: p.name,
    usageNote: p.usageNote,
    keyMode: p.keyMode,
    capabilities: p.proposal,
  };
}

/** The hosts or servers a request would reach, for a one-line summary. */
export function proposalReach(caps: ConnectorCapabilities): string[] {
  const out = new Set<string>();
  for (const m of caps.mcpServers) {
    if (m.url) {
      try {
        out.add(new URL(m.url).host);
      } catch {
        out.add(m.url);
      }
    }
    for (const h of m.allowedHosts) out.add(h);
  }
  for (const h of caps.allowedHosts) out.add(h);
  return [...out];
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
// derivation changes the scope mapping or ref shape, update BOTH this module
// and that test.
//
// THE DERIVATION. `keyMode` decides WHOSE key the connect flow prompts for /
// spends — reach derives PURELY from where the key attaches (no visibility flag
// on a credential):
//   'personal'  → credential scope 'agent'  — each agent adds its own key when
//                 it adds the connector (slice 5: never a person's).
//   'workspace' → credential scope 'global' — an admin supplies ONE company key;
//                 every allowed agent spends it as a shared service identity.
// Both modes use the SAME `account:<service>` ref — only the SCOPE differs.
// ---------------------------------------------------------------------------

/** The credential scope a connector slot's key binds to (reach-by-attachment).
 *  Only ever 'agent' (personal) or 'global' (workspace) — never a person's. */
export type ConnectorCredentialScope = 'agent' | 'global';

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

/** Build the per-agent / company vault ref for a service. Identical to
 *  `refForDestination({kind:'account', service, slot?})`. TASK-124 — pass `slot`
 *  for a multi-slot connector (→ `account:<service>:<slot>`); omit it for a
 *  single-slot connector (→ collapsed `account:<service>`, back-compat). */
export function accountRef(service: string, slot?: string): string {
  return slot !== undefined ? `account:${service}:${slot}` : `account:${service}`;
}

/** keyMode → the credential scope the key attaches to (reach-by-attachment). */
function scopeForKeyMode(keyMode: ConnectorKeyMode): ConnectorCredentialScope {
  return keyMode === 'workspace' ? 'global' : 'agent';
}

/**
 * Derive one credential-plan entry per declared credential slot. The connect flow
 * uses this to know WHOSE key to prompt for / spend: a `personal` connector
 * resolves every slot to the agent's own key (`scope:'agent'`), a `workspace`
 * connector to the single company key (`scope:'global'`). A connector with no
 * credential slots yields an empty plan (nothing to prompt — e.g. an MCP server
 * that needs no key); the connect flow treats that as "connected, needs no key".
 *
 * Also what the server-side rail presence read runs (`credentialChecks` in
 * `server/routes-workspace.ts`, which drops the OAuth client-secret ref the way
 * the host does — TASK-810), so it is one of THREE copies of the ref rule —
 * with @ax/connectors and @ax/chat-orchestrator's `connectorSlotRefs` (the
 * host's `connectorCredentialSlots` runs that one). `__tests__/connector-credential-refs-contract.test.ts`
 * runs every derivation over one fixture table (TASK-807, TASK-810).
 */
export function deriveCredentialPlan(
  connector: Connector,
): ConnectorCredentialPlanEntry[] {
  const scope = scopeForKeyMode(connector.keyMode);
  // TASK-124 — the collapse-vs-expand rule keys on the connector's slot COUNT
  // (mirrors @ax/connectors): exactly 1 slot keeps `account:<service>`; ≥2 slots
  // derive a distinct `account:<service>:<slot>` per slot (fixes the collision).
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

/** Where a connector's secret actually lands — the truthful, plain-language
 *  hint shown beneath each per-slot key field on the Credentials "Add a key"
 *  surface (TASK-132). */
export type MechanismHint = 'header' | 'request auth';

/**
 * Derive the truthful mechanism hint for a connector's credential slots
 * (TASK-132). A connector's backing mechanism is connector-level — the admin
 * Connector registry form edits a SINGLE leading mcpServer — so the hint keys off
 * that leading server's transport, or falls back to Direct API when the connector
 * has no MCP backing at all:
 *   - http MCP  → the secret is sent as an HTTP request header ("header");
 *   - no MCP    → Direct API: the secret is used in the request's auth ("request auth").
 *
 * This is a USER-FACING security-relevant label: it tells the keyholder where
 * their secret is actually used. Pinned by `connectors-credential-plan.test.ts`.
 */
export function mechanismHint(connector: Connector): MechanismHint {
  return connector.capabilities.mcpServers[0]?.transport === 'http'
    ? 'header'
    : 'request auth';
}

/** Extract a server `{ error }` message from a response body excerpt. */
function messageFrom(excerpt: string): string {
  try {
    return (JSON.parse(excerpt) as { error?: string }).error ?? '';
  } catch {
    return excerpt;
  }
}
