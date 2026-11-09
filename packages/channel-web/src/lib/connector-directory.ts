/**
 * TASK-1101 — the admin "Find in directory" client: search the host's mirror
 * of the public MCP server directory, and turn a listing into the create
 * editor's prefill.
 *
 * WIRE SHAPE. `GET /admin/connectors/directory?q=&cursor=` (admin-only)
 * answers the `DirectorySearchOutputLike` body in
 * `packages/connectors/src/directory-route.ts`. It is mirrored here, not
 * imported (invariant 2: channel-web imports no plugin at runtime), so
 * `DIRECTORY_QUERY_MAX` and the cursor rule below copy that file's
 * `DIRECTORY_QUERY_MAX` and `DIRECTORY_CURSOR_RE`. Change them together:
 * `src/__tests__/connector-directory-contract.test.ts` compares both, and
 * runs a body the route's own shaper built through `normalizeDirectoryPage`.
 *
 * UNTRUSTED. Every field of every listing is third-party registry text. The
 * host cleans it at sync and shapes it at the route, and this module still
 * reads it defensively, because a host bug must not be able to put a
 * verified shield on a listing. `normalizeDirectoryPage` NEVER UPGRADES
 * TRUST: only an exact `'domain'` is a proven publisher, only an exact
 * `'key'` or `'signin'` claims a way to connect, a listing without an id or
 * an address the editor can save (`serverHost`) is dropped, and `keyHeader` and `nextCursor` survive only
 * when they fit the rules the editor and the route apply. Callers render
 * every string as a React text node and show the address only as its host
 * (`directoryHost`), never as a link.
 */
import { newHeaderSlot } from './connector-credential-slots';
import type { Connector, ConnectorCredentialSlot, ConnectorPrefill } from './connectors';
import { headerNamePattern, serverHost } from './remote-mcp-form';

/**
 * `'key'`: the listing says a key is required. `'signin'`: the source says
 * people sign in. `'none'`: the listing declares no required key, which is
 * NOT "no sign-in" (the editor discovers sign-in from the address).
 */
export type DirectoryAuth = 'signin' | 'key' | 'none';

/** `'domain'`: the publisher proved control of a domain. `'account'`: anything less. */
export type PublisherProof = 'domain' | 'account';

export interface DirectoryEntry {
  /** The listing's name in the directory. Opaque. */
  id: string;
  title: string;
  description: string;
  publisher: string;
  publisherProof: PublisherProof;
  /** An https address. Shown only as `directoryHost(url)`, never as a link. */
  url: string;
  auth: DirectoryAuth;
  /** Only on a `'key'` listing, and only a valid request-header name. */
  keyHeader?: string;
  version: string;
  updatedAt: string;
  deprecated?: true;
}

export interface DirectoryPage {
  /** False when this workspace has no directory (turned off, or an older host). */
  enabled: boolean;
  entries: DirectoryEntry[];
  /** When the mirror last synced, or null if it never has. */
  syncedAt: string | null;
  /** The last sync failed, so this list may be out of date. */
  stale: boolean;
  /** Only listings from domain-proven publishers are served. */
  verifiedOnly: boolean;
  /** Send back as `cursor` for the next page. Absent on the last page. */
  nextCursor?: string;
}

/** The route's cap on `q`, in UTF-16 code units. A longer query is a 400. */
export const DIRECTORY_QUERY_MAX = 200;

/** The cursor alphabet and length the route accepts. */
export const DIRECTORY_CURSOR_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** What a workspace without a directory answers. A fresh object on every call. */
export function directoryOffPage(): DirectoryPage {
  return { enabled: false, entries: [], syncedAt: null, stale: false, verifiedOnly: false };
}

/**
 * One page of listings matching `query`. An empty query answers the
 * directory's state (enabled, freshness) with no rows. A 404 means this host
 * has no directory route (an older host, or the dev mock), which reads as
 * turned off. Any other failure throws.
 */
export async function searchDirectory(
  query: string,
  options: { cursor?: string; signal?: AbortSignal } = {},
): Promise<DirectoryPage> {
  // URLSearchParams keeps `&`, `#`, `%`, `+` and spaces inside the one value.
  const params = new URLSearchParams({ q: query });
  if (options.cursor) params.set('cursor', options.cursor);
  const res = await fetch(`/admin/connectors/directory?${params}`, {
    credentials: 'include',
    ...(options.signal && { signal: options.signal }),
  });
  if (res.status === 404) return directoryOffPage();
  if (!res.ok) throw new Error(`search directory: ${res.status}`);
  return normalizeDirectoryPage(await res.json());
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One listing, or null when it can't be used. Never throws. */
function normalizeEntry(raw: unknown): DirectoryEntry | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id);
  const url = text(raw.url);
  // One client rule: an address the editor's `serverHost` refuses (not https,
  // a port, a fragment, credentials, over 2048) would open an editor that can
  // never save, so the listing is dropped here instead.
  if (!id || serverHost(url) === undefined) return null;
  const title = text(raw.title);
  const auth: DirectoryAuth = raw.auth === 'key' || raw.auth === 'signin' ? raw.auth : 'none';
  const keyHeader = text(raw.keyHeader);
  return {
    id,
    title: title.trim() ? title : id,
    description: text(raw.description),
    publisher: text(raw.publisher),
    publisherProof: raw.publisherProof === 'domain' ? 'domain' : 'account',
    url,
    auth,
    ...(auth === 'key' && headerNamePattern.test(keyHeader) && { keyHeader }),
    version: text(raw.version),
    updatedAt: text(raw.updatedAt),
    ...(raw.deprecated === true && { deprecated: true as const }),
  };
}

/**
 * Read a route body defensively (see the header). Anything that isn't an
 * object reads as turned off, and flags are true only when exactly `true`.
 */
export function normalizeDirectoryPage(raw: unknown): DirectoryPage {
  if (!isRecord(raw)) return directoryOffPage();
  const entries = Array.isArray(raw.entries)
    ? raw.entries.flatMap((e) => {
        const entry = normalizeEntry(e);
        return entry ? [entry] : [];
      })
    : [];
  const nextCursor = text(raw.nextCursor);
  return {
    enabled: raw.enabled === true,
    entries,
    syncedAt: typeof raw.syncedAt === 'string' ? raw.syncedAt : null,
    stale: raw.stale === true,
    verifiedOnly: raw.verifiedOnly === true,
    ...(DIRECTORY_CURSOR_RE.test(nextCursor) && { nextCursor }),
  };
}

const SLUG_MAX = 48;

/**
 * A new connector's id from a listing's title: a slug the server accepts
 * (`^[a-z0-9][a-z0-9_-]*$`, at most 128, in
 * `packages/connectors/src/store.ts:28`), then `-` and 8 random hex. Titles
 * can fall back to directory names like `com.stripe/mcp`, which
 * `connectorIdFromName` would keep the `.` of. The suffix means two listings
 * with one title, or one listing added twice, never clash: the remote editor
 * has no id field, so a clash would strand the admin. It also keeps the id
 * off the reserved `directory` and `authored`.
 */
function connectorIdForTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return `${slug || 'connector'}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * What "Set it up" opens the create editor with. The shape is the one
 * `prefillForRemoteForm` carries whole: ONE http server named after the
 * connector (the name the editor saves it under), with its own hosts and
 * slots empty, and the key or sign-in as a TOP-LEVEL slot whose `server`
 * names it. A slot nested inside the server would be dropped into `leftOut`.
 * The URL's host is added to `allowedHosts` by the editor on save.
 *
 * Always `'personal'` (each agent brings its own key): the narrower grant,
 * and the editor's own default. A key listing without a usable header gets
 * no slot, and the admin adds the header in the editor.
 */
export function prefillFromDirectoryEntry(entry: DirectoryEntry): ConnectorPrefill {
  const connectorId = connectorIdForTitle(entry.title);
  const credentials: ConnectorCredentialSlot[] = [];
  if (entry.auth === 'key' && entry.keyHeader) {
    credentials.push({
      slot: newHeaderSlot(),
      kind: 'api-key',
      headerName: entry.keyHeader,
      server: connectorId,
    });
  } else if (entry.auth === 'signin') {
    credentials.push({ slot: 'MCP_OAUTH', kind: 'oauth', server: connectorId });
  }
  return {
    connectorId,
    name: entry.title,
    usageNote: entry.description,
    keyMode: 'personal',
    capabilities: {
      allowedHosts: [],
      credentials,
      mcpServers: [
        {
          name: connectorId,
          transport: 'http',
          url: entry.url,
          allowedHosts: [],
          credentials: [],
        },
      ],
      packages: { npm: [], pypi: [] },
    },
    fromDirectory: { directoryId: entry.id, version: entry.version },
  };
}

/** The address's host (punycode for a non-ASCII name), or '' when it isn't a URL. */
export function directoryHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * One server, however it is written: the scheme, the host (lowercase, with a
 * default port dropped), the path without trailing slashes, and the query.
 * Another path on the same host is another server. Null when `url` isn't a
 * URL.
 */
export function serverAddressKey(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return null;
  }
}

/** The address key of every server of every connector that has one. */
export function connectorServerAddresses(connectors: readonly Connector[]): Set<string> {
  const keys = new Set<string>();
  for (const connector of connectors) {
    for (const server of connector.capabilities.mcpServers) {
      const key = server.url === undefined ? null : serverAddressKey(server.url);
      if (key !== null) keys.add(key);
    }
  }
  return keys;
}
