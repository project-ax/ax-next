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

/** An empty capability fill — the default for a fresh connector. */
export function emptyCapabilities(): ConnectorCapabilities {
  return {
    allowedHosts: [],
    credentials: [],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  };
}

/** Extract a server `{ error }` message from a response body excerpt. */
function messageFrom(excerpt: string): string {
  try {
    return (JSON.parse(excerpt) as { error?: string }).error ?? '';
  } catch {
    return excerpt;
  }
}
