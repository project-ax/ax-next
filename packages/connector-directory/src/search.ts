/**
 * `connectors:directory-search` over OUR copy of the registry: parameterized
 * SQL, ranked domain-first, paged with our own opaque cursor. Nothing here
 * talks to the registry.
 *
 * Matching is `strpos` on lowercased text, a literal substring: `%`, `_`, a
 * backslash or a quote in the query mean themselves, with no escaping to get
 * wrong. A sequential scan over at most MAX_ROWS rows is fine for an
 * admin-only, typed search (decisions shard, ranking row).
 */
import { PluginError } from '@ax/core';
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  CURSOR_MAX,
  DirectorySearchInputSchema,
  QUERY_MAX,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  type DirectoryEntry,
  type DirectorySearchOutput,
} from './contract.js';
import { MAX_ROWS } from './limits.js';
import type { ConnectorDirectoryDatabase, ConnectorDirectoryEntriesTable } from './migrations.js';
import { cleanText } from './normalize.js';
import { PLUGIN_NAME } from './registry-client.js';
import { createDirectoryStore } from './store.js';

const CURSOR_SHAPE = new RegExp(`^[A-Za-z0-9_-]{1,${CURSOR_MAX}}$`);

/** A refusal with fixed text: never the input that was refused. */
function invalid(message: string): PluginError {
  return new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message });
}

/** Our cursor: base64url of `{"o":offset}`. Opaque to callers. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

/**
 * The offset inside a cursor we wrote: an integer from 0 to MAX_ROWS under a
 * single key `o`, encoded exactly the way `encodeCursor` encodes it. Anything
 * else is PluginError `invalid-payload` 'invalid cursor'.
 */
export function decodeCursor(cursor: string): number {
  if (!CURSOR_SHAPE.test(cursor)) throw invalid('invalid cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid('invalid cursor');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('invalid cursor');
  }
  const keys = Object.keys(parsed);
  const offset = (parsed as Record<string, unknown>)['o'];
  if (
    keys.length !== 1 ||
    typeof offset !== 'number' ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > MAX_ROWS ||
    // Only the bytes we would have written: no padding, spacing or `1e3`.
    encodeCursor(offset) !== cursor
  ) {
    throw invalid('invalid cursor');
  }
  return offset;
}

export interface SearchRequest {
  /** Cleaned the way stored text was; '' = nothing to look for. */
  query: string;
  /** 1..SEARCH_LIMIT_MAX. */
  limit: number;
  offset: number;
}

/**
 * Validate a hook input. The query is cleaned exactly as stored text was at
 * sync (controls, bidi and zero-width characters become spaces, whitespace
 * collapses), so what an admin pastes matches what was stored, and a NUL never
 * reaches Postgres. Throws PluginError `invalid-payload` with fixed text.
 */
export function parseSearchInput(input: unknown): SearchRequest {
  const parsed = DirectorySearchInputSchema.safeParse(input);
  if (!parsed.success) throw invalid('invalid directory search input');
  const { query, limit, cursor } = parsed.data;
  return {
    query: cleanText(query, QUERY_MAX),
    limit: Math.min(SEARCH_LIMIT_MAX, Math.max(1, limit ?? SEARCH_LIMIT_DEFAULT)),
    offset: cursor === undefined || cursor === '' ? 0 : decodeCursor(cursor),
  };
}

type EntryRow = Selectable<ConnectorDirectoryEntriesTable>;

/**
 * Domain-proven listings first; then, within a tier: 0 = the query is a whole
 * dot-label of the publisher (Notion's own listing has no title, so this is
 * what puts `notion.com` above a third party titled "Notion"), 1 = title
 * equals, 2 = title starts with, 3 = title contains, 4 = id or publisher
 * contains, 5 = description only; then title, then id, so the order is total.
 * One extra row tells whether a further page exists.
 */
async function rankedRows(
  db: Kysely<ConnectorDirectoryDatabase>,
  { query, limit, offset }: SearchRequest,
  verifiedOnly: boolean,
): Promise<EntryRow[]> {
  const result = await sql<EntryRow>`
    WITH params AS (SELECT lower(${query}::text) AS q)
    SELECT e.id, e.title, e.description, e.publisher, e.publisher_proof, e.url,
           e.auth, e.key_header, e.version, e.updated_at, e.deprecated
    FROM connector_directory_v1_entries e CROSS JOIN params p
    WHERE (strpos(lower(e.title), p.q) > 0
        OR strpos(lower(e.description), p.q) > 0
        OR strpos(lower(e.publisher), p.q) > 0
        OR strpos(lower(e.id), p.q) > 0)
      ${verifiedOnly ? sql`AND e.publisher_proof = 'domain'` : sql``}
    ORDER BY
      CASE WHEN e.publisher_proof = 'domain' THEN 0 ELSE 1 END,
      CASE
        WHEN strpos('.' || lower(e.publisher) || '.', '.' || p.q || '.') > 0 THEN 0
        WHEN lower(e.title) = p.q THEN 1
        WHEN strpos(lower(e.title), p.q) = 1 THEN 2
        WHEN strpos(lower(e.title), p.q) > 0 THEN 3
        WHEN strpos(lower(e.id), p.q) > 0 OR strpos(lower(e.publisher), p.q) > 0 THEN 4
        ELSE 5
      END,
      lower(e.title),
      e.id
    LIMIT ${limit + 1} OFFSET ${offset}
  `.execute(db);
  return result.rows;
}

function toEntry(r: EntryRow): DirectoryEntry {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    publisher: r.publisher,
    publisherProof: r.publisher_proof,
    url: r.url,
    auth: r.auth,
    ...(r.key_header === null ? {} : { keyHeader: r.key_header }),
    version: r.version,
    updatedAt: r.updated_at.toISOString(),
    ...(r.deprecated ? { deprecated: true as const } : {}),
  };
}

/**
 * Answer one search from the mirror. Freshness is always reported; entries
 * only once a sync has completed (a partial first crawl is never served) and
 * only for a non-empty query. `stale` = the last attempt failed while a
 * complete copy exists.
 */
export async function searchDirectory(
  db: Kysely<ConnectorDirectoryDatabase>,
  input: unknown,
  opts: { verifiedOnly: boolean },
): Promise<DirectorySearchOutput> {
  const request = parseSearchInput(input);
  const state = await createDirectoryStore(db).readState();
  const syncedAt = state?.syncedAt ?? null;
  const answer = {
    enabled: true,
    syncedAt: syncedAt === null ? null : syncedAt.toISOString(),
    stale: syncedAt !== null && state?.lastAttemptFailed === true,
    verifiedOnly: opts.verifiedOnly,
  };
  if (request.query === '' || syncedAt === null) return { ...answer, entries: [] };

  const rows = await rankedRows(db, request, opts.verifiedOnly);
  const next = request.offset + request.limit;
  return {
    ...answer,
    entries: rows.slice(0, request.limit).map(toEntry),
    ...(rows.length > request.limit && next <= MAX_ROWS ? { nextCursor: encodeCursor(next) } : {}),
  };
}
