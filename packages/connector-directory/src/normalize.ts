/**
 * One raw registry listing -> what the mirror does with it: upsert a cleaned
 * row, delete any stored row with that name, or touch nothing.
 *
 * Every field is UNTRUSTED third-party content, so this reads it with
 * hand-written, bounded type checks instead of zod (a zod parse of a junk
 * entry can build a large issue list, see `@ax/core/response-cap`), looks at
 * no more than MAX_REMOTES_CONSIDERED remotes and MAX_HEADERS_CONSIDERED
 * headers, and never throws: a hostile listing can only drop itself, never
 * fail the page it arrived on. The registry's own vocabulary (`remotes`,
 * `packages`, `_meta`, `isLatest`, `io.github.*`) stops here.
 *
 * The rules and the measurements behind them are in
 * `.claude/memory/decisions/2026-11-09-TASK-1100.md`.
 */
import { clampCodeUnits, toWellFormedText } from '@ax/core';
import { REWRITES_THE_SURFACE, replaceSurfaceRewriters } from '@ax/core/surface-text';
import type { DirectoryAuth, PublisherProof } from './contract.js';
import {
  DESCRIPTION_MAX,
  ID_MAX,
  KEY_HEADER_MAX,
  MAX_HEADERS_CONSIDERED,
  MAX_REMOTES_CONSIDERED,
  TITLE_MAX,
  URL_MAX,
  VERSION_MAX,
} from './limits.js';

/** One mirrored listing, ready to store. */
export interface DirectoryRow {
  id: string;
  title: string;
  description: string;
  publisher: string;
  publisherProof: PublisherProof;
  url: string;
  auth: DirectoryAuth;
  keyHeader: string | null;
  version: string;
  updatedAt: Date;
  deprecated: boolean;
}

export type EntryPlan =
  | { kind: 'upsert'; row: DirectoryRow }
  | { kind: 'delete'; id: string; reason: 'deleted' | 'no-usable-remote' | 'invalid-fields' }
  | { kind: 'skip'; reason: 'malformed' | 'not-latest' };

/** The registry's server-name pattern (namespace/name). */
const SERVER_NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

/**
 * An RFC 3339 date-time with a four-digit year. `Date.parse` alone accepts far
 * more: V8 guesses at strings like "1", and an expanded year such as
 * -271821 is an instant a Postgres TIMESTAMPTZ cannot hold, so one listing
 * carrying it would fail its page on every sync.
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The connectors' `headerName` rule (RFC 7230 token characters), copied
 * verbatim from `packages/connectors/src/types.ts` ApiKeySlotSchema. Its
 * reserved-name refine is NOT copied: the connectors save path still refuses
 * those names, and one source of truth beats two.
 */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** `io.github.<login>`: a GitHub account, the login as GitHub limits it. */
const GITHUB_LOGIN = /^io\.github\.([A-Za-z0-9-]{1,39})$/i;
/** Anything in the io.github family, so `github.io` never reads as a domain. */
const GITHUB_FAMILY = /^io\.github(?:\.|$)/i;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOP_LEVEL_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/;

const WHITESPACE = /\s/;
const WHITESPACE_RUNS = /\s+/g;

const MALFORMED: EntryPlan = { kind: 'skip', reason: 'malformed' };
const NOT_LATEST: EntryPlan = { kind: 'skip', reason: 'not-latest' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Display text: each run of controls (U+0000 included), bidi and zero-width
 * characters becomes a space FIRST, then lone surrogates become U+FFFD,
 * whitespace collapses, and the result is trimmed and clamped without
 * splitting a surrogate pair. The order is load-bearing: `toWellFormedText`
 * first would leave U+FFFD where a NUL was.
 */
export function cleanText(raw: string, max: number): string {
  const oneLine = toWellFormedText(replaceSurfaceRewriters(raw, ' '))
    .replace(WHITESPACE_RUNS, ' ')
    .trim();
  return clampCodeUnits(oneLine, max).trimEnd();
}

/**
 * The address a connector would call, as its WHATWG `href` (an IDN homograph
 * shows as punycode), or null. The raw-string checks come first because the
 * parser forgives too much: it accepts `{` in a host and silently drops a
 * newline inside one, so the raw text and the host called could differ.
 */
function usableRemoteUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > URL_MAX) return null;
  if (
    WHITESPACE.test(raw) ||
    REWRITES_THE_SURFACE.test(raw) ||
    raw.includes('{') ||
    raw.includes('}')
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  return url.href.length <= URL_MAX ? url.href : null;
}

/**
 * The first streamable-http remote with a usable address, else the first sse
 * one, else null. Only those two transports are callable by URL.
 */
export function pickRemote(remotes: unknown): { url: string; headers: unknown } | null {
  if (!Array.isArray(remotes)) return null;
  let sse: { url: string; headers: unknown } | null = null;
  const considered = Math.min(remotes.length, MAX_REMOTES_CONSIDERED);
  for (let i = 0; i < considered; i += 1) {
    const remote: unknown = remotes[i];
    if (!isRecord(remote)) continue;
    const type = remote['type'];
    if (type !== 'streamable-http' && (type !== 'sse' || sse !== null)) continue;
    const url = usableRemoteUrl(remote['url']);
    if (url === null) continue;
    if (type === 'streamable-http') return { url, headers: remote['headers'] };
    sse = { url, headers: remote['headers'] };
  }
  return sse;
}

/**
 * `'key'` when the remote declares a REQUIRED credential header (required, and
 * secret or named Authorization); `keyHeader` only when exactly one distinct
 * name (case-insensitive) is declared and it is a usable header name.
 * Otherwise `'none'`, which means "declares no required key", not "no
 * sign-in". Never `'signin'`: the registry has no way to declare it.
 */
export function deriveAuth(headers: unknown): { auth: DirectoryAuth; keyHeader?: string } {
  const seen = new Set<string>();
  let first = '';
  if (Array.isArray(headers)) {
    const considered = Math.min(headers.length, MAX_HEADERS_CONSIDERED);
    for (let i = 0; i < considered; i += 1) {
      const h: unknown = headers[i];
      if (!isRecord(h)) continue;
      const name = h['name'];
      if (typeof name !== 'string' || h['isRequired'] !== true) continue;
      const lower = name.toLowerCase();
      if (h['isSecret'] !== true && lower !== 'authorization') continue;
      if (seen.has(lower)) continue;
      if (seen.size === 0) first = name;
      seen.add(lower);
    }
  }
  if (seen.size === 0) return { auth: 'none' };
  if (seen.size === 1 && first.length <= KEY_HEADER_MAX && HEADER_NAME.test(first)) {
    return { auth: 'key', keyHeader: first };
  }
  return { auth: 'key' };
}

/**
 * Who published a listing, and how strongly that is proven, from its
 * namespace. `io.github.<login>` is a GitHub account (checked first, and the
 * whole io.github family stays an account). A lowercase reverse-DNS namespace
 * with an alphabetic or `xn--` top-level label is a proven domain, written the
 * usual way round. Anything else is an account named as written: proof never
 * upgrades on a guess.
 *
 * `'domain'` is read from the namespace's SHAPE, so it is proof only because
 * the source registry verifies namespace ownership before it accepts a
 * publish (the official one does: a DNS or HTTP challenge for a reverse-DNS
 * namespace, a GitHub sign-in for `io.github.*`). Against a subregistry that
 * does not verify namespaces, every reverse-DNS name would read as a proven
 * domain; the chart's `connectorDirectory.registryUrl` comment says so.
 */
export function derivePublisher(namespace: string): {
  publisher: string;
  publisherProof: PublisherProof;
} {
  const login = GITHUB_LOGIN.exec(namespace)?.[1];
  if (login !== undefined) return { publisher: login, publisherProof: 'account' };
  if (!GITHUB_FAMILY.test(namespace) && namespace === namespace.toLowerCase()) {
    const labels = namespace.split('.');
    if (
      labels.length >= 2 &&
      labels.every((label) => DNS_LABEL.test(label)) &&
      TOP_LEVEL_LABEL.test(labels[0] ?? '')
    ) {
      return { publisher: labels.reverse().join('.'), publisherProof: 'domain' };
    }
  }
  return { publisher: namespace, publisherProof: 'account' };
}

/**
 * A version is provenance material (compared verbatim later), so it is never
 * rewritten: one that would need cleaning drops the listing instead.
 */
function isUsableVersion(version: unknown): version is string {
  return (
    typeof version === 'string' &&
    version.length >= 1 &&
    version.length <= VERSION_MAX &&
    !REWRITES_THE_SURFACE.test(version) &&
    toWellFormedText(version) === version
  );
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || !RFC3339.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Decide what one raw registry entry does to the mirror. Never throws.
 *
 * - skip `malformed`: not an object, or no valid server name (nothing to key on).
 * - skip `not-latest`: a superseded version says nothing about the latest.
 * - delete `deleted`: the registry says so.
 * - delete `no-usable-remote`: the newest version has no https remote we would
 *   call (package-only, stdio, templated, credentialed, oversized), so a row
 *   stored from an older version must go too.
 * - delete `invalid-fields`: an unknown status, an unusable version, or no
 *   parseable timestamp.
 */
export function planEntry(raw: unknown): EntryPlan {
  if (!isRecord(raw)) return MALFORMED;
  const server = raw['server'];
  if (!isRecord(server)) return MALFORMED;
  const id = server['name'];
  if (typeof id !== 'string' || id.length > ID_MAX || !SERVER_NAME.test(id)) return MALFORMED;

  const metaHolder = raw['_meta'];
  const official = isRecord(metaHolder) ? metaHolder[OFFICIAL_META] : undefined;
  const meta = isRecord(official) ? official : {};

  if (meta['isLatest'] === false) return NOT_LATEST;

  const status = meta['status'];
  if (status === 'deleted') return { kind: 'delete', id, reason: 'deleted' };
  if (status !== undefined && status !== 'active' && status !== 'deprecated') {
    return { kind: 'delete', id, reason: 'invalid-fields' };
  }

  const remote = pickRemote(server['remotes']);
  if (remote === null) return { kind: 'delete', id, reason: 'no-usable-remote' };

  const version = server['version'];
  if (!isUsableVersion(version)) return { kind: 'delete', id, reason: 'invalid-fields' };

  const updatedAt =
    parseTimestamp(meta['updatedAt']) ??
    parseTimestamp(meta['statusChangedAt']) ??
    parseTimestamp(meta['publishedAt']);
  if (updatedAt === null) return { kind: 'delete', id, reason: 'invalid-fields' };

  const rawTitle = server['title'];
  const title = typeof rawTitle === 'string' ? cleanText(rawTitle, TITLE_MAX) : '';
  const rawDescription = server['description'];
  const { publisher, publisherProof } = derivePublisher(id.slice(0, id.indexOf('/')));
  const { auth, keyHeader } = deriveAuth(remote.headers);

  return {
    kind: 'upsert',
    row: {
      id,
      title: title.length > 0 ? title : id,
      description:
        typeof rawDescription === 'string' ? cleanText(rawDescription, DESCRIPTION_MAX) : '',
      publisher,
      publisherProof,
      url: remote.url,
      auth,
      keyHeader: keyHeader ?? null,
      version,
      updatedAt,
      deprecated: status === 'deprecated',
    },
  };
}
