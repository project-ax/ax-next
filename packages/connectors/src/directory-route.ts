// ---------------------------------------------------------------------------
// GET /admin/connectors/directory — local mirrors of the
// `connectors:directory-search` hook contract (owned by @ax/connector-directory;
// Invariant 2: no import, so the shapes are copied here and kept in step by the
// wire test). The hook is an OPTIONAL call: without the plugin the route
// answers 200 with the "turned off" body.
//
// The admin client in channel-web (lib/connector-directory.ts) mirrors the cap,
// the cursor rule and the body's field names in turn. Its test-only
// connector-directory-contract.test.ts imports them from this package's index
// and fails when the two drift.
// ---------------------------------------------------------------------------

export const DIRECTORY_SEARCH_HOOK = 'connectors:directory-search';
/** UTF-16 code units, as the hook's own cap. */
export const DIRECTORY_QUERY_MAX = 200;
export const DIRECTORY_PAGE_SIZE = 20;
/** The opaque cursor alphabet (base64url) and length the hook issues. */
export const DIRECTORY_CURSOR_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface DirectoryEntryLike {
  id: string;
  title: string;
  description: string;
  publisher: string;
  publisherProof: 'domain' | 'account';
  url: string;
  auth: 'signin' | 'key' | 'none';
  keyHeader?: string;
  version: string;
  updatedAt: string;
  deprecated?: true;
}

export interface DirectorySearchInputLike {
  query: string;
  limit: number;
  cursor?: string;
}

export interface DirectorySearchOutputLike {
  enabled: boolean;
  entries: DirectoryEntryLike[];
  syncedAt: string | null;
  stale: boolean;
  verifiedOnly: boolean;
  nextCursor?: string;
}

/** What the route answers when no directory plugin is loaded. */
export const DIRECTORY_OFF_BODY: DirectorySearchOutputLike = {
  enabled: false,
  entries: [],
  syncedAt: null,
  stale: false,
  verifiedOnly: false,
};

function shapeEntry(e: DirectoryEntryLike): DirectoryEntryLike {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    publisher: e.publisher,
    publisherProof: e.publisherProof,
    url: e.url,
    auth: e.auth,
    ...(e.keyHeader !== undefined && { keyHeader: e.keyHeader }),
    version: e.version,
    updatedAt: e.updatedAt,
    ...(e.deprecated === true && { deprecated: true as const }),
  };
}

/**
 * Copy only the contract's fields, entry by entry, so a provider that adds a
 * debug field (or leaves a raw remote on an entry) cannot widen the wire.
 */
export function shapeDirectoryBody(out: DirectorySearchOutputLike): DirectorySearchOutputLike {
  return {
    enabled: out.enabled,
    entries: out.entries.map(shapeEntry),
    syncedAt: out.syncedAt,
    stale: out.stale,
    verifiedOnly: out.verifiedOnly,
    ...(out.nextCursor !== undefined && { nextCursor: out.nextCursor }),
  };
}
