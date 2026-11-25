// ---------------------------------------------------------------------------
// @ax/auth-better: GET /admin/people?q=, find a person by name (TASK-1247).
//
// The sharing picker's directory read ("Who can use <agent>?", Add owner).
// Signed-in people only. It answers `{ id, displayName }` per person and
// nothing else. It never returns an email and the match never reads one, so
// the route can't tell anyone whether an address has an account, or whose
// name goes with it. This plugin is the only one allowed to read
// `auth_better_v1_users` (types.ts), so it owns the read, the projection and
// the limit; no hook exposes a search.
//
// Rules (decisions/2026-11-25-TASK-1247.md):
//   - `q` is trimmed, 2 to 64 code points, plain text (no control, bidi or
//     zero-width character), else 400 invalid-query.
//   - It matches the start of any word of the display name, ignoring case.
//     Never LIKE/ILIKE, so `%` and `_` are plain characters.
//     Known limitation (follow-up): word starts are matched on the RAW stored
//     name, where a word break is an ASCII space. A tab, or a bidi or
//     zero-width character, between two words is not a break, so the second
//     word isn't found by its start even though the fenced name shows it.
//   - At most 10 people, in name order. Each name is fenced
//     (fencePersonName), and a name that fences to nothing is left out.
//   - 60 searches a minute per person, then 429 rate-limited with
//     retry-after: 60. Invalid queries count too.
//   - Every answer the handler writes is cache-control: private, no-store.
//     (A store failure's 500 is @ax/http-server's own, `{ error: 'internal' }`
//     and nothing else.)
//
// There is no email_verified filter: every row is an account, by the rule
// @ax/agents' isAxAccount uses, and a verified-only search would hide people
// the sharing writes accept (the wizard admin before their first sign-in).
//
// Logs: nothing on success, and never the query. A failed session check goes
// through answerRequireUserFailure. A store failure propagates, and
// @ax/http-server answers 500 and logs codes only.
// ---------------------------------------------------------------------------

import { answerRequireUserFailure, type AgentContext } from '@ax/core';
import { REWRITES_THE_SURFACE, replaceSurfaceRewriters } from '@ax/core/surface-text';
import { sql, type Kysely } from 'kysely';
// Type-only, as in plugin.ts: never a runtime value from a peer plugin (I2).
import type { HttpRequest, HttpResponse } from '@ax/http-server';
import type { AuthBetterDatabase } from './migrations.js';
import { createPerUserRateLimiter } from './per-user-rate-limit.js';

export const PEOPLE_QUERY_MIN_CHARS = 2;
export const PEOPLE_QUERY_MAX_CHARS = 64;
export const PEOPLE_RESULTS_MAX = 10;
export const PEOPLE_SEARCHES_PER_MINUTE = 60;
export const PERSON_NAME_MAX_CHARS = 80;

const WINDOW_MS = 60_000;
/** People the limiter tracks at once; past this, new people wait a minute. */
const MAX_TRACKED_USERS = 10_000;

const RATE_LIMITED_MESSAGE =
  "That's a lot of searching in a minute. Give it a moment and try again.";

export interface PersonMatch {
  id: string;
  displayName: string;
}

/**
 * The search text, trimmed, or null when it isn't one: not a string, fewer
 * than 2 or more than 64 code points, or carrying a control, bidi or
 * zero-width character. A person types a name; none of those belong in one,
 * and a NUL would reach Postgres, which refuses it in text (a 500, not a
 * 400).
 */
export function parsePeopleQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const query = raw.trim();
  // A code point is at most two UTF-16 units, so this many units is already
  // too many code points. It bounds the walk below.
  if (query.length > PEOPLE_QUERY_MAX_CHARS * 2) return null;
  const points = [...query].length;
  if (points < PEOPLE_QUERY_MIN_CHARS || points > PEOPLE_QUERY_MAX_CHARS) return null;
  if (REWRITES_THE_SURFACE.test(query)) return null;
  return query;
}

/**
 * A display name as one plain, bounded line, or null when nothing legible is
 * left. Display names are user-written (the identity provider's profile, the
 * setup wizard), so a bidi override or a zero-width run could make one person
 * look like another in a sharing picker. Each run of those characters becomes
 * a space (`@ax/core/surface-text`), whitespace collapses, and the name is cut
 * to 80 code points (79 and an ellipsis). The same rule as channel-web's
 * `fenceLine`, which this plugin can't import (invariant 2).
 */
export function fencePersonName(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const flattened = replaceSurfaceRewriters(raw).replace(/\s+/g, ' ').trim();
  if (flattened.length === 0) return null;
  const points = [...flattened];
  if (points.length <= PERSON_NAME_MAX_CHARS) return flattened;
  return `${points.slice(0, PERSON_NAME_MAX_CHARS - 1).join('').trimEnd()}…`;
}

/**
 * The people whose display name has a word starting with `query`, ignoring
 * case: at most 10, by name, then id. `query` is a bound parameter, compared
 * with starts_with and strpos, never LIKE, so nothing in it is a wildcard.
 * The email column is neither read nor matched.
 */
export async function findPeople(
  db: Kysely<AuthBetterDatabase>,
  query: string,
): Promise<PersonMatch[]> {
  const name = sql.ref('name');
  const rows = await db
    .selectFrom('auth_better_v1_users')
    .select(['id', 'name'])
    .where('name', 'is not', null)
    .where(
      sql<boolean>`(starts_with(lower(btrim(${name})), lower(${query})) OR strpos(lower(btrim(${name})), ' ' || lower(${query})) > 0)`,
    )
    .orderBy(sql`lower(btrim(${name}))`)
    .orderBy('id')
    .limit(PEOPLE_RESULTS_MAX)
    .execute();
  const people: PersonMatch[] = [];
  for (const row of rows) {
    const displayName = fencePersonName(row.name);
    if (displayName !== null) people.push({ id: row.id, displayName });
  }
  return people;
}

export interface PeopleSearchDeps {
  /**
   * The signed-in person's id. Throws `PluginError{ code: 'unauthenticated' }`
   * when nobody is signed in; anything else it throws is a fault.
   */
  currentUserId(req: HttpRequest): Promise<string>;
  findPeople(query: string): Promise<PersonMatch[]>;
  /** For the log line when the session check fails. */
  ctx: AgentContext;
  /** The limiter's clock (tests). */
  now?: () => number;
}

/**
 * GET /admin/people. In order: no-store, sign-in (401, or a logged 500), the
 * per-person limit (429), the query (400), then the search (200).
 */
export function createPeopleSearchHandler(
  deps: PeopleSearchDeps,
): (req: HttpRequest, res: HttpResponse) => Promise<void> {
  const limiter = createPerUserRateLimiter({
    limit: PEOPLE_SEARCHES_PER_MINUTE,
    windowMs: WINDOW_MS,
    maxUsers: MAX_TRACKED_USERS,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  return async (req, res) => {
    res.header('cache-control', 'private, no-store');

    let userId: string;
    try {
      userId = await deps.currentUserId(req);
    } catch (err) {
      answerRequireUserFailure(deps.ctx, res, err, 'auth_people_search_require_user_failed');
      return;
    }

    if (!limiter.take(userId)) {
      res.header('retry-after', String(WINDOW_MS / 1000));
      res.status(429).json({ error: 'rate-limited', message: RATE_LIMITED_MESSAGE });
      return;
    }

    const query = parsePeopleQuery(req.query['q']);
    if (query === null) {
      res.status(400).json({ error: 'invalid-query' });
      return;
    }

    const found = await deps.findPeople(query);
    res.status(200).json({ people: toWire(found) });
  };
}

/**
 * The answer's people, built field by field: `{ id, displayName }` and
 * nothing else, each name fenced, at most 10. findPeople already does all of
 * this; doing it again here means a store that returned more (an email, an
 * unfenced name, a longer list) still couldn't put it on the wire.
 */
function toWire(found: readonly PersonMatch[]): PersonMatch[] {
  const people: PersonMatch[] = [];
  for (const person of found) {
    if (people.length >= PEOPLE_RESULTS_MAX) break;
    const displayName = fencePersonName(person.displayName);
    if (displayName !== null) people.push({ id: person.id, displayName });
  }
  return people;
}
